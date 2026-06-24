/**
 * pi extension — registers a `patch`-style `edit` tool that shadows pi's
 * built-in `edit`.
 *
 * Load with:  pi -e ./src/index.ts
 *   or drop into ~/.pi/agent/extensions/patch-edit/index.ts for auto-discovery.
 *
 * Registering a tool with the same name as a built-in shadows it (pi prints a
 * warning when this happens). This tool accepts a unified diff instead of
 * oldText/newText pairs; all logic lives in ./patch.ts (pure, tested) and
 * ./apply.ts (filesystem).
 *
 * @earendil-works/pi-coding-agent and typebox are peer dependencies provided
 * by pi at runtime; they're also in devDependencies so `tsc` can typecheck
 * this file locally.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyDiffToFile, resolvePatchPath } from "./apply.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit", // shadows pi's built-in edit
		label: "Edit (diff)",
		description: [
			"Apply a unified diff to an existing file. Accepts standard unified diff format",
			"(the same format `git diff` produces). Multiple hunks for one file in a single call.",
			"Line numbers in `@@` headers are respected; the text after the closing `@@` (the",
			"section header, e.g. `class Foo:`) is used to validate the target scope and to",
			"correct obviously-wrong line numbers. Fuzzy: tolerates line-number drift and",
			"trailing-whitespace differences via context matching.",
			"Only edits existing files — use `write` to create files, `bash` (mv/rm) for",
			"renames/deletions. File headers (`---`/`+++`) in the diff are ignored; the `path`",
			"argument is authoritative.",
		].join(" "),
		promptSnippet: "Apply a unified diff (git-diff format) to an existing file",
		promptGuidelines: [
			"Use edit (diff) when editing an existing file with multiple hunks or when you already have a git-diff in hand.",
			"edit only edits existing files — never use it to create, rename, or delete files (use write or bash for those).",
			"In edit diffs, include a section header after the closing `@@` naming the enclosing scope (e.g. `@@ -10,7 +10,7 @@ class Foo:`); it is used to validate the target and correct wrong line numbers.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to an existing file to edit (relative or absolute)." }),
			diff: Type.String({
				description:
					"Unified diff for one file. `@@` hunks required; `---`/`+++` headers optional and ignored. Generate with `git diff` or write by hand.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Resolve once for the queue key; applyDiffToFile resolves again
			// internally via the same helper, so the key and the written path agree.
			const { absolute: absolutePath } = resolvePatchPath(ctx.cwd, params.path);
			const result = await withFileMutationQueue(absolutePath, () => applyDiffToFile(ctx.cwd, params));

			return {
				content: [{ type: "text", text: formatResult(result) }],
				details: {
					path: result.path,
					applied: result.applied,
					hunks: result.hunks,
					error: result.error,
				},
			};
		},
	});
}

function formatResult(r: { applied: boolean; error?: string; hunks: unknown[]; path: string }): string {
	if (!r.applied) {
		return `Failed to patch ${r.path}: ${r.error ?? "unknown error"}`;
	}
	return `Patched ${r.path}: ${r.hunks.length} hunk(s) applied.`;
}
