import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiffToFile } from "../src/apply.ts";

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pi-patch-edit-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("applyDiffToFile", () => {
	it("applies a diff to an existing file and writes the result", async () => {
		await withTmpDir(async (cwd) => {
			const path = join(cwd, "src.ts");
			await writeFile(path, "a\nb\nc\n", "utf8");
			const diff = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";

			const result = await applyDiffToFile(cwd, { path, diff });

			assert.equal(result.applied, true);
			assert.equal(result.path, path);
			assert.equal(await readFile(path, "utf8"), "a\nB\nc\n");
		});
	});

	it("does not report content when the patch fails, and leaves the file untouched", async () => {
		await withTmpDir(async (cwd) => {
			const path = join(cwd, "src.ts");
			const original = "a\nb\nc\n";
			await writeFile(path, original, "utf8");
			const diff = "@@ -1,2 +1,2 @@\n x\n-y\n+z\n"; // context "x" absent

			const result = await applyDiffToFile(cwd, { path, diff });

			assert.equal(result.applied, false);
			assert.equal(result.content, undefined);
			assert.equal(await readFile(path, "utf8"), original); // unchanged
			assert.match(result.error ?? "", /Patch did not apply/);
		});
	});

	it("rejects a non-existent file and points to the write tool", async () => {
		await withTmpDir(async (cwd) => {
			const result = await applyDiffToFile(cwd, { path: "missing.ts", diff: "@@ -1,1 +1,1 @@\n-x\n+y\n" });

			assert.equal(result.applied, false);
			assert.equal(result.content, undefined);
			assert.match(result.error ?? "", /File not found/);
			assert.match(result.error ?? "", /write tool/);
		});
	});

	it("strips a leading @ from the path (built-in tool parity)", async () => {
		await withTmpDir(async (cwd) => {
			const path = join(cwd, "file.ts");
			await writeFile(path, "a\nb\n", "utf8");
			const diff = "@@ -1,2 +1,2 @@\n a\n-b\n+B\n";

			const result = await applyDiffToFile(cwd, { path: "@" + path, diff });

			assert.equal(result.applied, true);
			assert.equal(await readFile(path, "utf8"), "a\nB\n");
		});
	});

	it("handles a no-op diff without rewriting the file unnecessarily", async () => {
		await withTmpDir(async (cwd) => {
			const path = join(cwd, "file.ts");
			const original = "a\nb\n";
			await writeFile(path, original, "utf8");

			const result = await applyDiffToFile(cwd, { path, diff: "" });

			assert.equal(result.applied, true);
			assert.equal(result.content, original);
			assert.equal(await readFile(path, "utf8"), original);
		});
	});
});
