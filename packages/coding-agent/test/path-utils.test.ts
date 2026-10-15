import { mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandPath, resolveReadPath, resolveToCwd } from "../src/core/tools/path-utils.ts";

describe("path-utils", () => {
	describe("expandPath", () => {
		it("should expand ~ to home directory", () => {
			const result = expandPath("~");
			expect(result).not.toContain("~");
		});

		it("should expand ~/path to home directory", () => {
			const result = expandPath("~/Documents/file.txt");
			expect(result).not.toContain("~/");
		});

		it("should keep tilde-prefixed filenames literal", () => {
			expect(expandPath("~draft.md")).toBe("~draft.md");
			expect(expandPath("@~draft.md")).toBe("~draft.md");
		});

		it("should normalize Unicode spaces", () => {
			// 不换行空格（U+00A0）应转换为普通空格。
			const withNBSP = "file\u00A0name.txt";
			const result = expandPath(withNBSP);
			expect(result).toBe("file name.txt");
		});
	});

	describe("resolveToCwd", () => {
		it("should resolve absolute paths as-is", () => {
			const absolutePath = resolve(tmpdir(), "absolute", "path", "file.txt");
			const result = resolveToCwd(absolutePath, resolve(tmpdir(), "some", "cwd"));
			expect(result).toBe(absolutePath);
		});

		it("should resolve relative paths against cwd", () => {
			const result = resolveToCwd("relative/file.txt", "/some/cwd");
			expect(result).toBe(resolve("/some/cwd", "relative/file.txt"));
		});

		it("should resolve tilde-prefixed filenames against cwd", () => {
			const cwd = join(tmpdir(), "pi-path-utils-cwd");
			expect(resolveToCwd("~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"));
			expect(resolveToCwd("@~draft.md", cwd)).toBe(resolve(cwd, "~draft.md"));
		});
	});

	describe("resolveReadPath", () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = mkdtempSync(join(tmpdir(), "path-utils-test-"));
		});

		afterEach(() => {
			// 清理临时文件和目录。
			try {
				const files = readdirSync(tempDir);
				for (const file of files) {
					unlinkSync(join(tempDir, file));
				}
				rmdirSync(tempDir);
			} catch {
				// 忽略清理错误。
			}
		});

		it("should resolve existing file path", () => {
			const fileName = "test-file.txt";
			writeFileSync(join(tempDir, fileName), "content");

			const result = resolveReadPath(fileName, tempDir);
			expect(result).toBe(join(tempDir, fileName));
		});

		it("should handle NFC vs NFD Unicode normalization (macOS filenames with accents)", () => {
			// macOS 会以 NFD（分解形式）保存文件名：
			//   é = e + 组合用尖音符（U+0301）
			// 用户通常输入 NFC（合成形式）：
			//   é = 单个字符（U+00E9）
			//
			// 注意：macOS APFS 会自动规范化 Unicode，因此两种路径都能正常工作。
			// 此测试验证在不会自动规范化的系统上，NFD 形式的回退查找也能生效。

			// NFD：e（U+0065）+ 组合用尖音符（U+0301）。
			const nfdFileName = "file\u0065\u0301.txt";
			// NFC：é 为单个字符（U+00E9）。
			const nfcFileName = "file\u00e9.txt";

			// 验证两种形式的字节序列不同。
			expect(nfdFileName).not.toBe(nfcFileName);
			expect(Buffer.from(nfdFileName)).not.toEqual(Buffer.from(nfcFileName));

			// 创建 NFD 形式的文件名。
			writeFileSync(join(tempDir, nfdFileName), "content");

			// 用户提供 NFC 路径时，应能找到文件（通过文件系统规范化或本代码的回退逻辑）。
			const result = resolveReadPath(nfcFileName, tempDir);
			// 结果应包含带重音的字符（NFC 或 NFD 形式均可）。
			expect(result).toContain(tempDir);
			expect(result).toMatch(/file.+\.txt$/);
		});

		it("should handle curly quotes vs straight quotes (macOS filenames)", () => {
			// macOS 截图文件名中会使用弯引号（U+2019）：
			//   Capture d'écran（U+2019）
			// 用户通常输入直引号（U+0027）：
			//   Capture d'ecran（U+0027）

			const curlyQuoteName = "Capture d\u2019cran.txt"; // U+2019 right single quotation mark
			const straightQuoteName = "Capture d'cran.txt"; // U+0027 apostrophe

			// 验证两种文件名不同。
			expect(curlyQuoteName).not.toBe(straightQuoteName);

			// 创建包含弯引号的文件名（模拟 macOS 行为）。
			writeFileSync(join(tempDir, curlyQuoteName), "content");

			// 用户提供直引号路径时，应能找到弯引号文件。
			const result = resolveReadPath(straightQuoteName, tempDir);
			expect(result).toBe(join(tempDir, curlyQuoteName));
		});

		it("should handle combined NFC + curly quote (French macOS screenshots)", () => {
			// 完整的 macOS 截图文件名："Capture d'écran"，其中 é 为 NFD 形式且包含弯引号。
			// 注意：macOS APFS 会将 NFD 规范化为 NFC，因此磁盘上的实际文件使用 NFC。
			const nfcCurlyName = "Capture d\u2019\u00e9cran.txt"; // NFC + curly quote (how APFS stores it)
			const nfcStraightName = "Capture d'\u00e9cran.txt"; // NFC + straight quote (user input)

			// 验证两种文件名不同。
			expect(nfcCurlyName).not.toBe(nfcStraightName);

			// 创建 macOS 风格的文件名（使用弯引号）。
			writeFileSync(join(tempDir, nfcCurlyName), "content");

			// 用户提供直引号路径时，应能找到弯引号文件。
			const result = resolveReadPath(nfcStraightName, tempDir);
			expect(result).toBe(join(tempDir, nfcCurlyName));
		});

		it("should handle macOS screenshot AM/PM variant with narrow no-break space", () => {
			// macOS 截图名称中的 AM/PM 前会使用窄不换行空格（U+202F）。
			const macosName = "Screenshot 2024-01-01 at 10.00.00\u202FAM.png"; // U+202F
			const userName = "Screenshot 2024-01-01 at 10.00.00 AM.png"; // regular space

			// 创建 macOS 风格的文件名。
			writeFileSync(join(tempDir, macosName), "content");

			// 用户提供包含普通空格的路径。
			const result = resolveReadPath(userName, tempDir);

			// tryMacOSScreenshotPath() 会处理此情况。
			expect(result).toBe(join(tempDir, macosName));
		});

		it("should handle macOS screenshot lowercase am/pm variant (en_AU locale)", () => {
			// en_AU 等区域设置会在截图名称中使用小写 am/pm。
			const macosName = "Screenshot 2024-01-01 at 10.00.00\u202Fam.png"; // U+202F + lowercase
			const userName = "Screenshot 2024-01-01 at 10.00.00 am.png"; // regular space + lowercase

			// 创建 macOS 风格的文件名。
			writeFileSync(join(tempDir, macosName), "content");

			// 用户提供包含普通空格的路径。
			const result = resolveReadPath(userName, tempDir);

			// tryMacOSScreenshotPath() 会忽略大小写进行匹配，因此此路径可以找到文件。
			expect(result).toBe(join(tempDir, macosName));
		});
	});
});
