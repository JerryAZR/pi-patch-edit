/**
 * Filesystem wrapper around `applyDiff`.
 *
 * Owns path resolution, the "file must already exist" boundary (creation is
 * `write`'s job), and reading/writing. The extension wraps the whole
 * read-modify-write in pi's `withFileMutationQueue` so concurrent edits to the
 * same file serialize (see src/index.ts).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyDiff, type ApplyOptions, type ApplyOutcome } from "./patch.ts";

export interface PatchFileInput {
	path: string;
	diff: string;
}

export interface PatchFileResult extends ApplyOutcome {
	/** Cleaned path (leading @ stripped) — what was actually touched. */
	path: string;
}

/**
 * Strip a leading @ (some models prepend it to path args, like built-in tools
 * do) and resolve against cwd. Returns both the cleaned display path and the
 * absolute path so callers don't re-derive either.
 */
export function resolvePatchPath(cwd: string, path: string): { clean: string; absolute: string } {
	const clean = path.startsWith("@") ? path.slice(1) : path;
	return { clean, absolute: resolve(cwd, clean) };
}

export async function applyDiffToFile(
	cwd: string,
	input: PatchFileInput,
	options: ApplyOptions = {},
): Promise<PatchFileResult> {
	const { clean, absolute: absolutePath } = resolvePatchPath(cwd, input.path);

	let source: string;
	try {
		source = await readFile(absolutePath, "utf8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				path: clean,
				applied: false,
				hunks: [],
				error: `File not found: ${clean}. The edit tool only edits existing files; use the write tool to create new files.`,
			};
		}
		throw err;
	}

	const outcome = applyDiff(source, input.diff, options);

	if (outcome.applied && outcome.content !== undefined && outcome.content !== source) {
		await writeFile(absolutePath, outcome.content, "utf8");
	}

	return { path: clean, ...outcome };
}
