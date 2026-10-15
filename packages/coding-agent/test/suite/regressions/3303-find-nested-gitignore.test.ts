import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../../../src/core/tools/find.ts";

/**
 * https://github.com/earendil-works/pi/issues/3303 的回归测试。
 *
 * `find` 工具此前会收集搜索目录下的所有 `.gitignore` 文件，
 * 路径并通过 `--ignore-file` 传给 `fd`。fd 会将 `--ignore-file`
 * 中的条目视为单一全局忽略来源，因此 `a/.gitignore` 中的规则
 * 也会过滤同级目录 `b/` 中的文件。修复方案改用 fd 通过 `--no-require-git` 实现的
 * 分层 `.gitignore` 处理，并移除手动收集逻辑。
 */
describe("issue #3303 nested .gitignore rules leak into sibling directories", () => {
	let tempRoot: string;

	async function runFind(pattern: string): Promise<string[]> {
		const def = createFindToolDefinition(tempRoot);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", { pattern }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = result.content[0]?.text ?? "";
		if (text === "No files found matching pattern") return [];
		return text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("["))
			.sort();
	}

	afterEach(() => {
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	});

	describe("flat sibling case", () => {
		beforeEach(() => {
			tempRoot = mkdtempSync(join(tmpdir(), "pi-3303-flat-"));
			mkdirSync(join(tempRoot, "a"), { recursive: true });
			mkdirSync(join(tempRoot, "b"), { recursive: true });
			writeFileSync(join(tempRoot, "a", ".gitignore"), "ignored.txt\n");
			writeFileSync(join(tempRoot, "a", "ignored.txt"), "");
			writeFileSync(join(tempRoot, "a", "kept.txt"), "");
			writeFileSync(join(tempRoot, "b", "ignored.txt"), "");
			writeFileSync(join(tempRoot, "b", "kept.txt"), "");
			writeFileSync(join(tempRoot, "root.txt"), "");
		});

		it("applies a/.gitignore only inside a/ and leaves b/ untouched", async () => {
			const files = await runFind("**/*.txt");
			expect(files).toEqual(["a/kept.txt", "b/ignored.txt", "b/kept.txt", "root.txt"]);
		});
	});

	describe("deeply nested case", () => {
		beforeEach(() => {
			tempRoot = mkdtempSync(join(tmpdir(), "pi-3303-deep-"));
			mkdirSync(join(tempRoot, "a", "deep"), { recursive: true });
			mkdirSync(join(tempRoot, "b"), { recursive: true });
			writeFileSync(join(tempRoot, "a", ".gitignore"), "ignored.txt\n");
			writeFileSync(join(tempRoot, "a", "deep", ".gitignore"), "secret.txt\n");
			writeFileSync(join(tempRoot, "a", "ignored.txt"), "");
			writeFileSync(join(tempRoot, "a", "kept.txt"), "");
			writeFileSync(join(tempRoot, "a", "deep", "ignored.txt"), "");
			writeFileSync(join(tempRoot, "a", "deep", "secret.txt"), "");
			writeFileSync(join(tempRoot, "a", "deep", "kept.txt"), "");
			writeFileSync(join(tempRoot, "b", "ignored.txt"), "");
			writeFileSync(join(tempRoot, "b", "kept.txt"), "");
			writeFileSync(join(tempRoot, "root.txt"), "");
		});

		it("scopes each .gitignore to its own subtree", async () => {
			const files = await runFind("**/*.txt");
			// a/.gitignore 会忽略 a/ 和 a/deep/ 中的 'ignored.txt'。
			// a/deep/.gitignore additionally ignores 'secret.txt' within a/deep/.
			// b/ 不受这两份规则影响。
			expect(files).toEqual(["a/deep/kept.txt", "a/kept.txt", "b/ignored.txt", "b/kept.txt", "root.txt"]);
		});
	});
});
