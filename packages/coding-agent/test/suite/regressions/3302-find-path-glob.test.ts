import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../../../src/core/tools/find.ts";

/**
 * https://github.com/earendil-works/pi/issues/3302 的回归测试。
 *
 * `find` 工具声明支持 `src/**\/*.spec.ts` 这样的 glob 模式，但默认的 fd 实现
 * 使用 `fd --glob <pattern>` 时没有指定 `--full-path`，导致 fd 只匹配文件名。
 * 因此，包含 `/` 的模式会静默地返回空结果。
 *
 * 修复方案是在模式包含 `/` 时让 fd 使用完整路径模式，
 * 并在模式前添加 `**\/`，使其能够匹配 fd 传给匹配器的候选绝对路径。
 */
describe("issue #3302 find returns no results for path-based glob patterns", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-3302-"));
		mkdirSync(join(tempRoot, "some", "parent", "child"), { recursive: true });
		mkdirSync(join(tempRoot, "src", "foo", "bar"), { recursive: true });
		writeFileSync(join(tempRoot, "some", "parent", "child", "file.ext"), "");
		writeFileSync(join(tempRoot, "some", "parent", "child", "test.spec.ts"), "");
		writeFileSync(join(tempRoot, "src", "foo", "bar", "example.spec.ts"), "");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	async function runFind(pattern: string): Promise<string[]> {
		const def = createFindToolDefinition(tempRoot);
		// find 工具实现不会访问 ctx，因此传入最小化的桩对象。
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", { pattern }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = result.content[0]?.text ?? "";
		if (text === "No files found matching pattern") return [];
		return text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("["));
	}

	it("basename pattern still matches (regression-safe)", async () => {
		const files = await runFind("*.spec.ts");
		expect(files.sort()).toEqual(["some/parent/child/test.spec.ts", "src/foo/bar/example.spec.ts"]);
	});

	it("directory-prefixed pattern with ** tail matches subtree", async () => {
		const files = await runFind("some/parent/child/**");
		// 匹配子树中的文件（也可能包括目录），并断言两个文件均出现在结果中。
		expect(files).toContain("some/parent/child/file.ext");
		expect(files).toContain("some/parent/child/test.spec.ts");
	});

	it("leading ** wildcard with path segments matches", async () => {
		const files = await runFind("**/parent/child/*");
		expect(files.sort()).toContain("some/parent/child/file.ext");
		expect(files.sort()).toContain("some/parent/child/test.spec.ts");
	});

	it("src/**/*.spec.ts matches nested spec file", async () => {
		const files = await runFind("src/**/*.spec.ts");
		expect(files).toEqual(["src/foo/bar/example.spec.ts"]);
	});
});
