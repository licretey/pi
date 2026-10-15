/**
 * isImageLine() 崩溃场景的回归测试。
 *
 * 问题：isImageLine() 使用 startsWith() 时，如果终端不支持图像，
 * 即使行内包含图像转义序列，函数仍会返回 false，导致 TUI 因
 * "Rendered line exceeds terminal width" 错误而崩溃。
 *
 * 修复：改用 includes() 检测行内任意位置的转义序列。
 *
 * 此测试验证：
 * 1. 旧实现会触发的问题场景。
 * 2. 修复后的实现能够正常工作。
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("Bug regression: isImageLine() crash with image escape sequences", () => {
	describe("Bug scenario: Terminal without image support", () => {
		it("old implementation would return false, causing crash", () => {
			/**
			 * 旧实现（存在问题）：
			 * ```typescript
			 * export function isImageLine(line: string): boolean {
			 *   const prefix = getImageEscapePrefix();
			 *   return prefix !== null && line.startsWith(prefix);
			 * }
			 * ```
			 *
			 * 终端不支持图像时：
			 * - getImageEscapePrefix() 返回 null。
			 * - 即使行内含有图像序列，isImageLine() 仍返回 false。
			 * - TUI 会对包含 300KB 以上 Base64 数据的行执行宽度检查。
			 * - 随后崩溃："Rendered line exceeds terminal width (304401 > 115)"。
			 */

			// 模拟旧实现的行为。
			const oldIsImageLine = (line: string, imageEscapePrefix: string | null): boolean => {
				return imageEscapePrefix !== null && line.startsWith(imageEscapePrefix);
			};

			// 终端不支持图像时，前缀为 null。
			const terminalWithoutImageSupport = null;

			// 图像转义序列前带有文本的行（常见问题场景）。
			const lineWithImageSequence =
				"Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64data...\x07";

			// 旧实现会返回 false（问题行为）。
			const oldResult = oldIsImageLine(lineWithImageSequence, terminalWithoutImageSupport);
			assert.strictEqual(
				oldResult,
				false,
				"Bug: old implementation returns false for line containing image sequence when terminal has no image support",
			);
		});

		it("new implementation returns true correctly", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// 图像转义序列前带有文本的行。
			const lineWithImageSequence =
				"Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64data...\x07";

			// 新实现应返回 true（修复后的行为）。
			const newResult = isImageLine(lineWithImageSequence);
			assert.strictEqual(newResult, true, "Fix: new implementation returns true for line containing image sequence");
		});

		it("new implementation detects Kitty sequences in any position", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			const scenarios = [
				"At start: \x1b_Ga=T,f=100,data...\x1b\\",
				"Prefix \x1b_Ga=T,data...\x1b\\",
				"Suffix text \x1b_Ga=T,data...\x1b\\ suffix",
				"Middle \x1b_Ga=T,data...\x1b\\ more text",
				// 超长行（模拟 300KB 以上内容导致崩溃的场景）。
				`Text before \x1b_Ga=T,f=100${"A".repeat(300000)} text after`,
			];

			for (const line of scenarios) {
				assert.strictEqual(isImageLine(line), true, `Should detect Kitty sequence in: ${line.slice(0, 50)}...`);
			}
		});

		it("new implementation detects iTerm2 sequences in any position", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			const scenarios = [
				"At start: \x1b]1337;File=size=100,100:base64...\x07",
				"Prefix \x1b]1337;File=inline=1:data==\x07",
				"Suffix text \x1b]1337;File=inline=1:data==\x07 suffix",
				"Middle \x1b]1337;File=inline=1:data==\x07 more text",
				// 超长行（模拟 304KB 内容导致崩溃的场景）。
				`Text before \x1b]1337;File=size=800,600;inline=1:${"B".repeat(300000)} text after`,
			];

			for (const line of scenarios) {
				assert.strictEqual(isImageLine(line), true, `Should detect iTerm2 sequence in: ${line.slice(0, 50)}...`);
			}
		});
	});

	describe("Integration: Tool execution scenario", () => {
		/**
		 * 模拟 `read` 工具读取图像文件时的情况。
		 * 工具结果同时包含文本和图像内容：
		 *
		 * ```typescript
		 * {
		 *   content: [
		 *     { type: "text", text: "Read image file [image/jpeg]\n800x600" },
		 *     { type: "image", data: "base64...", mimeType: "image/jpeg" }
		 *   ]
		 * }
		 * ```
		 *
		 * 渲染该结果时，图像组件会生成转义序列。
		 * 如果 isImageLine() 未能检测到这些序列，TUI 就会崩溃。
		 */

		it("detects image sequences in read tool output", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// 模拟 read 工具处理图像时的输出。
			// 该行可能同时包含读取结果中的文本和图像转义序列。
			const toolOutputLine = "Read image file [image/jpeg]\x1b]1337;File=size=800,600;inline=1:base64image...\x07";

			assert.strictEqual(isImageLine(toolOutputLine), true, "Should detect image sequence in tool output line");
		});

		it("detects Kitty sequences from Image component", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// Kitty 图像组件会生成包含转义序列的多行输出。
			const kittyLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";

			assert.strictEqual(isImageLine(kittyLine), true, "Should detect Kitty image component output");
		});

		it("handles ANSI codes before image sequences", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// 图像数据前可能有样式控制码（例如错误或警告样式）。
			const lines = [
				"\x1b[31mError\x1b[0m: \x1b]1337;File=inline=1:base64==\x07",
				"\x1b[33mWarning\x1b[0m: \x1b_Ga=T,data...\x1b\\",
				"\x1b[1mBold\x1b[0m \x1b]1337;File=:base64==\x07\x1b[0m",
			];

			for (const line of lines) {
				assert.strictEqual(
					isImageLine(line),
					true,
					`Should detect image sequence after ANSI codes: ${line.slice(0, 30)}...`,
				);
			}
		});
	});

	describe("Crash scenario simulation", () => {
		it("does NOT crash on very long lines with image sequences", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			/**
			 * 模拟实际崩溃场景：
			 * - 行长为 304,401 个字符（崩溃日志中记录了 58649 > 115）。
			 * - 行中某处包含图像转义序列。
			 * - 旧实现会返回 false，导致 TUI 执行宽度检查。
			 * - 新实现会返回 true，跳过宽度检查，从而避免崩溃。
			 */

			const base64Char = "A".repeat(100);
			const iterm2Sequence = "\x1b]1337;File=size=800,600;inline=1:";

			// 构造会触发崩溃的行。
			const crashLine =
				"Output: " +
				iterm2Sequence +
				base64Char.repeat(3040) + // ~304,000 chars
				" end of output";

			// 确认该行足够长。
			assert(crashLine.length > 300000, "Test line should be > 300KB");

			// 新实现应能检测到图像序列，从而避免崩溃。
			const detected = isImageLine(crashLine);
			assert.strictEqual(detected, true, "Should detect image sequence in very long line, preventing TUI crash");
		});

		it("handles lines exactly matching crash log dimensions", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			/**
			 * 崩溃日志显示：行宽为 58649 个字符，终端宽度为 115。
			 * 此处构造一行具有类似特征的内容。
			 */

			const targetWidth = 58649;
			const prefix = "Text";
			const sequence = "\x1b_Ga=T,f=100";
			const suffix = "End";
			const padding = "A".repeat(targetWidth - prefix.length - sequence.length - suffix.length);
			const line = `${prefix}${sequence}${padding}${suffix}`;

			assert.strictEqual(line.length, 58649);
			assert.strictEqual(isImageLine(line), true, "Should detect image sequence in 58649-char line");
		});
	});

	describe("Negative cases: Don't false positive", () => {
		it("does not detect images in regular long text", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			// 不含图像序列的超长行。
			const longText = "A".repeat(100000);

			assert.strictEqual(isImageLine(longText), false, "Should not detect images in plain long text");
		});

		it("does not detect images in lines with file paths", async () => {
			const { isImageLine } = await import("../src/terminal-image.ts");

			const filePaths = [
				"/path/to/1337/image.jpg",
				"/usr/local/bin/File_converter",
				"~/Documents/1337File_backup.png",
				"./_G_test_file.txt",
			];

			for (const path of filePaths) {
				assert.strictEqual(isImageLine(path), false, `Should not falsely detect image sequence in path: ${path}`);
			}
		});
	});
});
