import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

/**
 * 测试 truncateToWidth 对 Unicode 字符的处理。
 *
 * 这些测试用于验证 truncateToWidth 能正确处理字节长度和显示宽度不同的 Unicode 文本。
 */
describe("truncateToWidth", () => {
	it("should truncate messages with Unicode characters correctly", () => {
		// 此消息包含勾号（✔），其显示宽度可能大于一个字节。
		const message = '✔ script to run › dev $ concurrently "vite" "node --import tsx ./';
		const width = 67;
		const maxMsgWidth = width - 2; // 为光标预留宽度。

		const truncated = truncateToWidth(message, maxMsgWidth);
		const truncatedWidth = visibleWidth(truncated);

		expect(truncatedWidth).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should handle emoji characters", () => {
		const message = "🎉 Celebration! 🚀 Launch 📦 Package ready for deployment now";
		const width = 40;
		const maxMsgWidth = width - 2;

		const truncated = truncateToWidth(message, maxMsgWidth);
		const truncatedWidth = visibleWidth(truncated);

		expect(truncatedWidth).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should handle mixed ASCII and wide characters", () => {
		const message = "Hello 世界 Test 你好 More text here that is long";
		const width = 30;
		const maxMsgWidth = width - 2;

		const truncated = truncateToWidth(message, maxMsgWidth);
		const truncatedWidth = visibleWidth(truncated);

		expect(truncatedWidth).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should not truncate messages that fit", () => {
		const message = "Short message";
		const width = 50;
		const maxMsgWidth = width - 2;

		const truncated = truncateToWidth(message, maxMsgWidth);

		expect(truncated).toBe(message);
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should add ellipsis when truncating", () => {
		const message = "This is a very long message that needs to be truncated";
		const width = 30;
		const maxMsgWidth = width - 2;

		const truncated = truncateToWidth(message, maxMsgWidth);

		expect(truncated).toContain("...");
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(maxMsgWidth);
	});

	it("should handle the exact crash case from issue report", () => {
		// 终端宽度为 67 列，该行的可见宽度为 68 列。
		// 问题文本包含 "✔" 和 "›" 字符。
		const message = '✔ script to run › dev $ concurrently "vite" "node --import tsx ./server.ts"';
		const terminalWidth = 67;
		const cursorWidth = 2; // "› " or "  "
		const maxMsgWidth = terminalWidth - cursorWidth;

		const truncated = truncateToWidth(message, maxMsgWidth);
		const finalWidth = visibleWidth(truncated);

		// 最后一行（光标与消息）不得超出终端宽度。
		expect(finalWidth + cursorWidth).toBeLessThanOrEqual(terminalWidth);
	});
});
