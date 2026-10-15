import assert from "node:assert";
import { describe, it } from "node:test";
import { findWordBackward, findWordForward } from "../src/word-navigation.ts";

describe("findWordBackward", () => {
	it("basic words: hello world", () => {
		const text = "hello world";
		assert.strictEqual(findWordBackward(text, 11), 6);
		assert.strictEqual(findWordBackward(text, 6), 0);
	});

	it("dotted: foo.bar", () => {
		const text = "foo.bar";
		assert.strictEqual(findWordBackward(text, 7), 4);
		assert.strictEqual(findWordBackward(text, 4), 3);
		assert.strictEqual(findWordBackward(text, 3), 0);
	});

	it("colon: foo:bar", () => {
		const text = "foo:bar";
		assert.strictEqual(findWordBackward(text, 7), 4);
		assert.strictEqual(findWordBackward(text, 4), 3);
		assert.strictEqual(findWordBackward(text, 3), 0);
	});

	it("path: path/to/file", () => {
		const text = "path/to/file";
		assert.strictEqual(findWordBackward(text, 12), 8);
		assert.strictEqual(findWordBackward(text, 8), 7);
		// "/to" 是一个类词语片段，其中 "/" 是标点边界。
		assert.strictEqual(findWordBackward(text, 7), 5);
		assert.strictEqual(findWordBackward(text, 5), 4);
		assert.strictEqual(findWordBackward(text, 4), 0);
	});

	it("CJK mixed", () => {
		const text = "你好世界 test";
		assert.strictEqual(findWordBackward(text, text.length), 5);
		// Intl.Segmenter 会将每个中日韩字符视为单独的类词语片段。
		assert.strictEqual(findWordBackward(text, 5), 2);
		assert.strictEqual(findWordBackward(text, 2), 0);
	});

	it("whitespace at boundaries", () => {
		const text = "  hello  ";
		assert.strictEqual(findWordBackward(text, 9), 2);
		assert.strictEqual(findWordBackward(text, 2), 0);
	});

	it("punctuation run: foo...bar", () => {
		const text = "foo...bar";
		assert.strictEqual(findWordBackward(text, 9), 6);
		assert.strictEqual(findWordBackward(text, 6), 3);
		assert.strictEqual(findWordBackward(text, 3), 0);
	});

	it("cursor at 0 returns 0", () => {
		assert.strictEqual(findWordBackward("hello", 0), 0);
	});
});

describe("findWordForward", () => {
	it("basic words: hello world", () => {
		const text = "hello world";
		assert.strictEqual(findWordForward(text, 0), 5);
		assert.strictEqual(findWordForward(text, 5), 11);
	});

	it("dotted: foo.bar", () => {
		const text = "foo.bar";
		assert.strictEqual(findWordForward(text, 0), 3);
		assert.strictEqual(findWordForward(text, 3), 4);
		assert.strictEqual(findWordForward(text, 4), 7);
	});

	it("colon: foo:bar", () => {
		const text = "foo:bar";
		assert.strictEqual(findWordForward(text, 0), 3);
		assert.strictEqual(findWordForward(text, 3), 4);
		assert.strictEqual(findWordForward(text, 4), 7);
	});

	it("path: path/to/file", () => {
		const text = "path/to/file";
		assert.strictEqual(findWordForward(text, 0), 4);
		assert.strictEqual(findWordForward(text, 4), 5);
		assert.strictEqual(findWordForward(text, 5), 7);
		assert.strictEqual(findWordForward(text, 7), 8);
		assert.strictEqual(findWordForward(text, 8), 12);
	});

	it("CJK mixed", () => {
		const text = "你好世界 test";
		const firstEnd = findWordForward(text, 0);
		assert.ok(firstEnd > 0);
		assert.ok(firstEnd <= 4);
		// 一直移动到文本末尾。
		let pos = 0;
		while (pos < text.length) {
			const next = findWordForward(text, pos);
			if (next === pos) break;
			pos = next;
		}
		assert.strictEqual(pos, text.length);
	});

	it("whitespace at boundaries", () => {
		const text = "  hello  ";
		assert.strictEqual(findWordForward(text, 0), 7);
		assert.strictEqual(findWordForward(text, 7), 9);
	});

	it("punctuation run: foo...bar", () => {
		const text = "foo...bar";
		assert.strictEqual(findWordForward(text, 0), 3);
		assert.strictEqual(findWordForward(text, 3), 6);
		assert.strictEqual(findWordForward(text, 6), 9);
	});

	it("cursor at end returns end", () => {
		assert.strictEqual(findWordForward("hello", 5), 5);
	});
});

describe("atomic segments", () => {
	const marker = "[paste #1 +5 lines]";
	const text = `hello ${marker} world`;
	const isAtomic = (s: string) => s === marker;

	// 函数会先截取文本再调用 segment()，因此这里将每个预期子串映射到截取前的分段结果。
	const segmentMap = new Map<string, Intl.SegmentData[]>([
		[
			text, // 完整文本（实际不会用到，仅为便于理解）。
			[
				{ segment: "hello", index: 0, input: text, isWordLike: true },
				{ segment: " ", index: 5, input: text, isWordLike: false },
				{ segment: marker, index: 6, input: text, isWordLike: true },
				{ segment: " ", index: 25, input: text, isWordLike: false },
				{ segment: "world", index: 26, input: text, isWordLike: true },
			],
		],
		[
			// 从末尾向前：slice(0, 31) = 完整文本。
			text.slice(0, text.length),
			[
				{ segment: "hello", index: 0, input: text, isWordLike: true },
				{ segment: " ", index: 5, input: text, isWordLike: false },
				{ segment: marker, index: 6, input: text, isWordLike: true },
				{ segment: " ", index: 25, input: text, isWordLike: false },
				{ segment: "world", index: 26, input: text, isWordLike: true },
			],
		],
		[
			// 从位置 26 向前：slice(0, 26) = "hello [paste #1 +5 lines] "。
			text.slice(0, 26),
			[
				{ segment: "hello", index: 0, input: text, isWordLike: true },
				{ segment: " ", index: 5, input: text, isWordLike: false },
				{ segment: marker, index: 6, input: text, isWordLike: true },
				{ segment: " ", index: 25, input: text, isWordLike: false },
			],
		],
		[
			// 从位置 6 向后：slice(6) = "[paste #1 +5 lines] world"。
			text.slice(6),
			[
				{ segment: marker, index: 0, input: text, isWordLike: true },
				{ segment: " ", index: 19, input: text, isWordLike: false },
				{ segment: "world", index: 20, input: text, isWordLike: true },
			],
		],
	]);

	const opts = {
		segment: (input: string) => segmentMap.get(input) ?? [],
		isAtomicSegment: isAtomic,
	};

	it("backward skips word then stops before atomic marker", () => {
		assert.strictEqual(findWordBackward(text, text.length, opts), 26);
	});

	it("backward skips whitespace then atomic marker as one unit", () => {
		assert.strictEqual(findWordBackward(text, 26, opts), 6);
	});

	it("forward skips atomic marker as one unit", () => {
		assert.strictEqual(findWordForward(text, 6, opts), 6 + marker.length);
	});
});
