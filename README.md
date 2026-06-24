# pi-patch-edit

A git-diff/patch-inspired edit tool for the [pi coding agent](https://github.com/earendil-works/pi-mono). Shadows pi's built-in `edit` with a unified-diff interface.

## What it does

Replaces pi's `edit` tool (exact `oldText`/`newText` replacement) with one that accepts a **unified diff** — the format `git diff` produces, and the format LLMs are most fluent in.

```diff
@@ -10,7 +10,7 @@ class Foo {
     def bar(self):
-        return 1
+        return 2
```

- **Multiple hunks** for one file in a single call
- **Fuzzy matching**: tolerates line-number drift and trailing-whitespace differences via context lines (powered by the [`diff`](https://www.npmjs.com/package/diff) npm package)
- **Section-header guidance**: the text after `@@` (e.g. `class Foo:`) validates the target scope and corrects obviously-wrong line numbers
- **Line numbers respected**: `oldStart` is treated as a reliable hint (from `git diff`/`grep`, or approximately-right LLM guesses)
- **Edits only**: existing files only. Use `write` to create files, `bash` (`mv`/`rm`) for renames/deletions

## Install

```bash
pi install git:github.com/JerryAZR/pi-patch-edit
```

Or try without installing:

```bash
pi -e git:github.com/JerryAZR/pi-patch-edit
```

The tool shadows the built-in `edit` automatically (pi prints a shadow warning on load).

## How it works

1. **Parse** the unified diff with `diff`'s `parsePatch`; reject multi-file diffs (the tool takes an explicit `path`).
2. **Validate captions**: if a hunk's section header (text after `@@`) doesn't appear as a line in the file, reject the whole patch — likely the wrong file.
3. **Correct `oldStart`**: if a captioned hunk's `oldStart` points *before* the caption's first occurrence (nonsensical — the hunk can't be inside a scope that starts later), re-derive it to the first context line at/after the anchor. Otherwise keep `oldStart` as-is.
4. **Apply** all hunks in one batched `applyPatch` call on the whole source.

## Development

```bash
npm install      # installs diff + pi peer deps for typecheck
npm test         # 26 tests, no external deps
npm run typecheck
```

## License

MIT
