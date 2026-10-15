import assert from "node:assert";
import { describe, it } from "node:test";
import { visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";

describe("regional indicator width regression", () => {
	it("treats partial flag grapheme as full-width to avoid streaming render drift", () => {
		// 复现场景：
		// 流式输出期间，"🇨🇳" 常会先以中间态 "🇨" 出现。
		// 如果 "🇨" 被测量为宽度 1，而终端将它显示为宽度 2，
		// 差异渲染就会发生偏移，导致屏幕上残留旧字符。
		const partialFlag = "🇨";
		const listLine = "      - 🇨";

		assert.strictEqual(visibleWidth(partialFlag), 2);
		assert.strictEqual(visibleWidth(listLine), 10);
	});

	it("wraps intermediate partial-flag list line before overflow", () => {
		// 如果 🇨 的宽度为 2（8 + 2 = 10），宽度为 9 的行就无法容纳 "      - 🇨"。
		// 此处必须换行，以避免与终端自动换行行为不一致。
		const wrapped = wrapTextWithAnsi("      - 🇨", 9);

		assert.strictEqual(wrapped.length, 2);
		assert.strictEqual(visibleWidth(wrapped[0] || ""), 7);
		assert.strictEqual(visibleWidth(wrapped[1] || ""), 2);
	});

	it("treats all regional-indicator singleton graphemes as width 2", () => {
		for (let cp = 0x1f1e6; cp <= 0x1f1ff; cp++) {
			const regionalIndicator = String.fromCodePoint(cp);
			assert.strictEqual(
				visibleWidth(regionalIndicator),
				2,
				`Expected ${regionalIndicator} (U+${cp.toString(16).toUpperCase()}) to be width 2`,
			);
		}
	});

	it("keeps full flag pairs at width 2", () => {
		const samples = ["🇯🇵", "🇺🇸", "🇬🇧", "🇨🇳", "🇩🇪", "🇫🇷"];
		for (const flag of samples) {
			assert.strictEqual(visibleWidth(flag), 2, `Expected ${flag} to be width 2`);
		}
	});

	it("keeps common streaming emoji intermediates at stable width", () => {
		const samples = ["👍", "👍🏻", "✅", "⚡", "⚡️", "👨", "👨‍💻", "🏳️‍🌈"];
		for (const sample of samples) {
			assert.strictEqual(visibleWidth(sample), 2, `Expected ${sample} to be width 2`);
		}
	});
});
