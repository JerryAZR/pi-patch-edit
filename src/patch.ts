/**
 * Pure patch-application core — thin wrapper + anchor correction on `diff`.
 *
 * No filesystem, no cwd, no pi dependency. This is the unit-testable boundary.
 *
 * Design:
 *  - Single-file only. Multi-file diffs are rejected (the surrounding tool takes
 *    an explicit `path`; pi has `write`/`bash` for create/move/delete).
 *  - Filenames in `---`/`+++` headers are ignored. `path` is authoritative.
 *  - **Line numbers are respected.** The LLM's `oldStart` is treated as a
 *    reliable hint (it may come from a real `git diff`/`grep`, and even
 *    LLM-generated nearby line numbers are approximately right, not wildly off).
 *  - **Caption = validation + correction, not override.** The text after a
 *    hunk's closing `@@` (e.g. `@@ -10,7 +10,7 @@ class Foo:`) is the agent's
 *    statement of which scope it is editing. For each captioned hunk:
 *      * if the caption's text does not appear as a line in the file, the whole
 *        patch is rejected (assume the agent has the wrong file, not the wrong
 *        symbol);
 *      * if the hunk's `oldStart` points *before* the caption's first occurrence
 *        (nonsensical — the hunk can't be inside a scope that starts later),
 *        `oldStart` is re-derived to the first context line at/after the anchor;
 *      * otherwise `oldStart` is kept as-is.
 *    No caption → `oldStart` kept as-is.
 *  - **Batched apply.** All (possibly adjusted) hunks go to one upstream
 *    `applyPatch` call on the whole source. No slicing, no per-hunk diagnostics.
 */
import { applyPatch, parsePatch, type StructuredPatch, type StructuredPatchHunk } from "diff";

export interface ApplyOptions {
	/** Max tolerated context-line mismatches. Default 2. */
	fuzzFactor?: number;
	/**
	 * Line equality predicate. Default trims trailing whitespace so stray
	 * spaces / CR differences don't break matches. `line` may be `undefined`
	 * when the scanner probes past EOF on short files.
	 */
	compareLine?: (lineNumber: number, line: string | undefined, operation: string, patchContent: string) => boolean;
}

export interface HunkInfo {
	/** 0-based index within the parsed patch. */
	index: number;
	/** `oldStart` actually used (after anchor correction). 1-based. */
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** Section-header caption text after the closing `@@` (empty if none). */
	caption: string;
}

export interface ApplyOutcome {
	applied: boolean;
	/** New file content on success. Absent on failure. */
	content?: string;
	/** Per-hunk metadata on success (with adjusted `oldStart`); empty on failure. */
	hunks: HunkInfo[];
	/** Human-readable explanation on failure. */
	error?: string;
}

/** Trailing-whitespace-tolerant line comparison; null-safe for EOF probes. */
const DEFAULT_COMPARE_LINE = (
	_lineNumber: number,
	line: string | undefined,
	_operation: string,
	patchContent: string,
): boolean => line != null && line.trimEnd() === patchContent.trimEnd();

function hunkInfo(hunk: StructuredPatchHunk, index: number, caption: string): HunkInfo {
	return {
		index,
		oldStart: hunk.oldStart,
		oldLines: hunk.oldLines,
		newStart: hunk.newStart,
		newLines: hunk.newLines,
		caption,
	};
}

/**
 * Extract the section-header caption (text after the closing `@@`) for each
 * hunk, in order. `parsePatch` drops this text, so we re-scan the raw diff. For
 * a single-file patch (which we enforce before relying on this), `@@` lines map
 * 1:1 to hunks. Trimmed so the stored/messaged caption matches what
 * `findCaptionLineIn` compares.
 */
function extractCaptions(diff: string): string[] {
	const re = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[ \t]*(.*)$/gm;
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(diff)) !== null) {
		out.push(m[1]!.trim());
	}
	return out;
}

/**
 * Recompute each hunk's oldLines/newLines from its body and rewrite the `@@`
 * headers. `diff`'s `parsePatch` validates the header counts against the body
 * and throws on any mismatch, but the body is authoritative — the LLM can
 * miscount headers, but it writes the body by copying the actual lines. So we
 * re-derive the counts before parsing: each body line starting with `-` or ` `
 * counts toward oldLines; `+` or ` ` counts toward newLines; `\` (EOFNL) is
 * excluded from both. `oldStart`/`newStart` and the caption are preserved.
 *
 * Also re-extracts the caption from the original header so that information is
 * not lost when we rewrite the line. Returns the rewritten diff string and the
 * captions (in hunk order).
 */
function normalizeHunkCounts(diff: string): { diff: string; captions: string[] } {
	const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/gm;
	const lines = diff.split("\n");
	const out: string[] = [];
	const captions: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const m = hunkRe.exec(line);
		if (m) {
			const oldStart = m[1]!;
			const newStart = m[3]!;
			const caption = m[5]!.trim();
			// Count this hunk's body lines.
			let oldLines = 0;
			let newLines = 0;
			let j = i + 1;
			for (; j < lines.length; j++) {
				const body = lines[j]!;
				if (body.length === 0 && j !== lines.length - 1) {
					// diff encodes a blank context line as an empty string (the leading
					// space is stripped by the format). It counts toward both.
					oldLines++;
					newLines++;
					continue;
				}
				const op = body[0];
				if (op === " " || op === "-" || op === "+") {
					if (op === " " || op === "-") oldLines++;
					if (op === " " || op === "+") newLines++;
				} else if (op === "\\") {
					// "No newline at end of file" marker. It annotates the preceding
					// `-`/`+` line and is NOT counted toward either total, but it does
					// not terminate the hunk — a `+` line can follow a `\` marker (and
					// vice versa) when both sides lack a trailing newline.
					continue;
				} else {
					break; // next hunk header or file header
				}
			}
			captions.push(caption);
			out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${caption ? " " + caption : ""}`);
			// Copy the body lines verbatim (including any `\` markers).
			for (let k = i + 1; k < j; k++) out.push(lines[k]!);
			i = j;
			hunkRe.lastIndex = 0;
		} else {
			out.push(line);
			i++;
		}
	}
	return { diff: out.join("\n"), captions };
}

/** 0-based index of the first line whose trimmed content equals trimmed `caption`, or null. */
function findCaptionLineIn(lines: string[], caption: string): number | null {
	if (!caption) return null;
	const target = caption.trim();
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() === target) return i;
	}
	return null;
}

/**
 * 0-based index of the first *non-blank* hunk context (` `) line's occurrence
 * at or after `anchorIdx`, or null if the hunk has no usable context line or it
 * doesn't occur there. Used to re-derive `oldStart` when it points before the
 * anchor. Blank context lines are skipped (they match too many places to be
 * a useful anchor).
 */
function findFirstContextLineAtOrAfter(lines: string[], hunk: StructuredPatchHunk, anchorIdx: number): number | null {
	for (const raw of hunk.lines) {
		if (raw.length > 0 && raw[0] === " ") {
			const target = raw.slice(1).trim();
			if (!target) continue;
			for (let i = anchorIdx; i < lines.length; i++) {
				if (lines[i]!.trim() === target) return i;
			}
			return null;
		}
	}
	return null;
}

/**
 * Apply a unified diff to `source`, returning a structured outcome.
 *
 * @param source current file contents
 * @param diff   unified diff string; headerless hunks OK, file headers ignored
 * @param options fuzz / comparison tuning
 */
export function applyDiff(source: string, diff: string, options: ApplyOptions = {}): ApplyOutcome {
	const { fuzzFactor = 2, compareLine = DEFAULT_COMPARE_LINE } = options;

	// Recompute hunk line counts from the body before parsing. `diff`'s
	// `parsePatch` validates counts against the body and throws on mismatch, but
	// the body is authoritative — the LLM can miscount headers but copies the
	// actual lines. Also extracts captions (text after `@@`) so we don't re-scan.
	const { diff: normalized, captions } = normalizeHunkCounts(diff);

	let patches: StructuredPatch[];
	try {
		patches = parsePatch(normalized);
	} catch (err) {
		return {
			applied: false,
			hunks: [],
			error: `Failed to parse diff: ${(err as Error).message}`,
		};
	}

	if (patches.length === 0) {
		return { applied: true, content: source, hunks: [] };
	}
	if (patches.length > 1) {
		return {
			applied: false,
			hunks: [],
			error: `Diff contains ${patches.length} file sections. Apply one file at a time (the tool takes an explicit path).`,
		};
	}

	const patch = patches[0]!;
	if (patch.hunks.length === 0) {
		return { applied: true, content: source, hunks: [] };
	}

	const lines = source.split("\n");

	// Single pass: per hunk, find the anchor once (if captioned) and derive both
	// the missing-caption reject set and the adjusted oldStart from it. Splits the
	// source once, not once per call.
	const missing: string[] = [];
	const adjustedHunks: StructuredPatchHunk[] = [];
	for (let i = 0; i < patch.hunks.length; i++) {
		const hunk = patch.hunks[i]!;
		const cap = captions[i] ?? "";
		let oldStart = hunk.oldStart;
		if (cap) {
			const anchorIdx = findCaptionLineIn(lines, cap);
			if (anchorIdx === null) {
				missing.push(cap);
			} else if (hunk.oldStart - 1 < anchorIdx) {
				// oldStart points before the anchor → nonsensical; re-derive to the
				// first context line at/after the anchor (fall back to the anchor line).
				const ctxIdx = findFirstContextLineAtOrAfter(lines, hunk, anchorIdx);
				oldStart = (ctxIdx ?? anchorIdx) + 1; // back to 1-based
			}
		}
		adjustedHunks.push(oldStart === hunk.oldStart ? hunk : { ...hunk, oldStart });
	}

	if (missing.length > 0) {
		return {
			applied: false,
			hunks: [],
			error: `Section header not found in file: ${missing.map((c) => `\`${c}\``).join(", ")}. Verify the file path or that the symbol exists.`,
		};
	}

	const adjustedPatch: StructuredPatch = { ...patch, hunks: adjustedHunks };
	const result = applyPatch(source, adjustedPatch, { fuzzFactor, compareLine });

	if (result === false) {
		return {
			applied: false,
			hunks: [],
			error: "Patch did not apply. Verify that each hunk's context lines match the file, hunks are in file order, and the caption (if any) names the correct scope.",
		};
	}

	return {
		applied: true,
		content: result,
		hunks: adjustedHunks.map((h, i) => hunkInfo(h, i, captions[i] ?? "")),
	};
}
