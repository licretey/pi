import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor, wordWrapLine } from "../src/components/editor.ts";
import { FAKE_CURSOR_START, renderFakeCursor, type TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** 创建使用虚拟终端的 TUI 以供测试。 */
function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

/** 标准 applyCompletion 实现：将前缀替换为 item.value。 */
function applyCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: { value: string },
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const line = lines[cursorLine] || "";
	const before = line.slice(0, cursorCol - prefix.length);
	const after = line.slice(cursorCol);
	const newLines = [...lines];
	newLines[cursorLine] = before + item.value + after;
	return {
		lines: newLines,
		cursorLine,
		cursorCol: cursorCol - prefix.length + item.value.length,
	};
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

describe("Editor component", () => {
	describe("Prompt history navigation", () => {
		it("does nothing on Up arrow when history is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[A"); // 按向上键。

			assert.strictEqual(editor.getText(), "");
		});

		it("shows most recent history entry on Up arrow when editor is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first prompt");
			editor.addToHistory("second prompt");

			editor.handleInput("\x1b[A"); // 按向上键。

			assert.strictEqual(editor.getText(), "second prompt");
		});

		it("cycles through history entries on repeated Up arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");

			editor.handleInput("\x1b[A"); // 按向上键显示 "third"。
			assert.strictEqual(editor.getText(), "third");

			editor.handleInput("\x1b[A"); // 按向上键显示 "second"。
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("\x1b[A"); // 按向上键显示 "first"。
			assert.strictEqual(editor.getText(), "first");

			editor.handleInput("\x1b[A"); // 按向上键后仍停留在 "first"（最早的记录）。
			assert.strictEqual(editor.getText(), "first");
		});

		it("jumps to start before entering history from a non-empty draft", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("prompt");
			editor.setText("draft");
			editor.handleInput("\x1b[D");
			editor.handleInput("\x1b[D");

			editor.handleInput("\x1b[A"); // 浏览历史记录前，按向上键先将光标移至行首。
			assert.strictEqual(editor.getText(), "draft");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1b[A"); // 光标位于行首时按向上键，显示 "prompt"。
			assert.strictEqual(editor.getText(), "prompt");

			editor.handleInput("\x1b[B"); // 按向下键恢复草稿。
			assert.strictEqual(editor.getText(), "draft");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		it("navigates forward through history with Down arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");
			editor.setText("draft");

			// 移至最早的历史记录。
			editor.handleInput("\x1b[A"); // 草稿行首。
			editor.handleInput("\x1b[A"); // 第三条历史记录。
			editor.handleInput("\x1b[A"); // 第二条历史记录。
			editor.handleInput("\x1b[A"); // 第一条历史记录。

			// 向较新的记录导航。
			editor.handleInput("\x1b[B"); // 第二条历史记录。
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("\x1b[B"); // 第三条记录。
			assert.strictEqual(editor.getText(), "third");

			editor.handleInput("\x1b[B"); // 草稿。
			assert.strictEqual(editor.getText(), "draft");
		});

		it("exits history mode when typing a character", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("old prompt");

			editor.handleInput("\x1b[A"); // 按向上键显示 "old prompt"。
			editor.handleInput("x"); // 输入字符后退出历史记录浏览模式。

			assert.strictEqual(editor.getText(), "xold prompt");
		});

		it("exits history mode on setText", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");

			editor.handleInput("\x1b[A"); // 按向上键显示 "second"。
			editor.setText(""); // 外部清空文本。

			// 按向上键应从最近一条记录重新开始浏览。
			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getText(), "second");
		});

		it("does not add empty strings to history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("");
			editor.addToHistory("   ");
			editor.addToHistory("valid");

			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getText(), "valid");

			// 不应再有其他记录。
			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getText(), "valid");
		});

		it("does not add consecutive duplicates to history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("same");
			editor.addToHistory("same");
			editor.addToHistory("same");

			editor.handleInput("\x1b[A"); // 显示“same”。
			assert.strictEqual(editor.getText(), "same");

			editor.handleInput("\x1b[A"); // 只有一条记录，因此仍停留在“same”。
			assert.strictEqual(editor.getText(), "same");
		});

		it("allows non-consecutive duplicates in history", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("first"); // 两次操作不连续，因此应加入历史记录。

			editor.handleInput("\x1b[A"); // 第一条历史记录。
			assert.strictEqual(editor.getText(), "first");

			editor.handleInput("\x1b[A"); // “second”记录。
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("\x1b[A"); // 较早的那条“first”记录。
			assert.strictEqual(editor.getText(), "first");
		});

		it("uses cursor movement instead of history when editor has content", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("history item");
			editor.setText("line1\nline2");

			// 光标位于第二行末尾，按向上键应移至第一行。
			editor.handleInput("\x1b[A"); // 按向上键移动光标。

			// 插入字符以验证光标位置。
			editor.handleInput("X");

			// X 应插入第一行，而不是用历史记录替换当前文本。
			assert.strictEqual(editor.getText(), "line1X\nline2");
		});

		it("limits history to 100 entries", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 添加 105 条记录。
			for (let i = 0; i < 105; i++) {
				editor.addToHistory(`prompt ${i}`);
			}

			// 导航到最早的记录。
			for (let i = 0; i < 100; i++) {
				editor.handleInput("\x1b[A");
			}

			// 应停在第 5 条记录（保留记录中的最早一条），而不是第 0 条。
			assert.strictEqual(editor.getText(), "prompt 5");

			// 再按一次向上键也不应发生变化。
			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getText(), "prompt 5");
		});

		it("places cursor at start after browsing history upward", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("older entry");
			editor.addToHistory("line1\nline2\nline3");

			editor.handleInput("\x1b[A"); // 按向上键显示位于行首的多行记录。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1b[A"); // 再按一次向上键，立即导航到更早的历史记录。
			assert.strictEqual(editor.getText(), "older entry");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		it("places cursor at end after browsing history downward", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("older entry");
			editor.addToHistory("line1\nline2\nline3");
			editor.addToHistory("newer entry");

			editor.handleInput("\x1b[A"); // 较新的记录。
			editor.handleInput("\x1b[A"); // 多行记录。
			editor.handleInput("\x1b[A"); // 较早的记录。

			editor.handleInput("\x1b[B"); // 按向下键显示位于行尾的多行记录。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });

			editor.handleInput("\x1b[B"); // 再按一次向下键，立即导航到更新的历史记录。
			assert.strictEqual(editor.getText(), "newer entry");
		});

		it("allows opposite-direction cursor movement within multi-line history entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.addToHistory("line1\nline2\nline3");

			editor.handleInput("\x1b[A"); // 按向上键显示位于行首的记录。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1b[B"); // 按向下键将光标移至第 2 行。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			editor.handleInput("\x1b[A"); // 按向上键将光标移回第 1 行。
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});
	});

	describe("public state accessors", () => {
		it("returns cursor position", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("c");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			editor.handleInput("\x1b[D"); // 左方向键。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 });
		});

		it("returns lines as a defensive copy", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setText("a\nb");

			const lines = editor.getLines();
			assert.deepStrictEqual(lines, ["a", "b"]);

			lines[0] = "mutated";
			assert.deepStrictEqual(editor.getLines(), ["a", "b"]);
		});
	});

	describe("Backslash+Enter newline workaround", () => {
		it("inserts backslash immediately (no buffering)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");

			// 反斜杠应立即显示，不应被缓冲。
			assert.strictEqual(editor.getText(), "\\");
		});

		it("converts standalone backslash to newline on Enter", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");
			editor.handleInput("\r");

			assert.strictEqual(editor.getText(), "\n");
		});

		it("inserts backslash normally when followed by other characters", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");
			editor.handleInput("x");

			assert.strictEqual(editor.getText(), "\\x");
		});

		it("does not trigger newline when backslash is not immediately before cursor", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = false;

			editor.onSubmit = () => {
				submitted = true;
			};

			editor.handleInput("\\");
			editor.handleInput("x");
			editor.handleInput("\r");

			// 应提交内容，而不是插入换行符（反斜杠不在光标前）。
			assert.strictEqual(submitted, true);
		});

		it("only removes one backslash when multiple are present", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\\");
			editor.handleInput("\\");
			editor.handleInput("\\");
			assert.strictEqual(editor.getText(), "\\\\\\");

			editor.handleInput("\r");
			// 只删除最后一个反斜杠，并插入换行符。
			assert.strictEqual(editor.getText(), "\\\\\n");
		});
	});

	describe("Kitty CSI-u handling", () => {
		it("ignores printable CSI-u sequences with unsupported modifiers", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[99;9u");

			assert.strictEqual(editor.getText(), "");
		});

		it("inserts shifted CSI-u letters as text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[69;2u");

			assert.strictEqual(editor.getText(), "E");
		});

		it("inserts shifted xterm modifyOtherKeys letters as text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[27;2;69~");

			assert.strictEqual(editor.getText(), "E");
		});
	});

	describe("Unicode text editing behavior", () => {
		it("inserts mixed ASCII, umlauts, and emojis as literal text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("H");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput(" ");
			editor.handleInput("😀");

			const text = editor.getText();
			assert.strictEqual(text, "Hello äöü 😀");
		});

		it("deletes single-code-unit unicode characters (umlauts) with Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			// 删除最后一个字符（ü）。
			editor.handleInput("\x7f"); // 退格键。

			const text = editor.getText();
			assert.strictEqual(text, "äö");
		});

		it("deletes multi-code-unit emojis with single Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");

			// 删除最后一个表情符号（👍）；按一次退格键会删除整个字素簇。
			editor.handleInput("\x7f"); // 退格键。

			const text = editor.getText();
			assert.strictEqual(text, "😀");
		});

		it("inserts characters at the correct position after cursor movement over umlauts", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");

			// 将光标向左移动两次。
			editor.handleInput("\x1b[D"); // 左方向键。
			editor.handleInput("\x1b[D"); // 左方向键。

			// 在中间插入 'x'。
			editor.handleInput("x");

			const text = editor.getText();
			assert.strictEqual(text, "äxöü");
		});

		it("moves cursor across multi-code-unit emojis with single arrow key", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("😀");
			editor.handleInput("👍");
			editor.handleInput("🎉");

			// 将光标向左移过最后一个表情符号（🎉）；按一次方向键会跨过整个字素簇。
			editor.handleInput("\x1b[D"); // 左方向键。

			// 将光标向左移过第二个表情符号（👍）。
			editor.handleInput("\x1b[D");

			// 在第一个和第二个表情符号之间插入 'x'。
			editor.handleInput("x");

			const text = editor.getText();
			assert.strictEqual(text, "😀x👍🎉");
		});

		it("preserves umlauts across line breaks", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("ä");
			editor.handleInput("ö");
			editor.handleInput("ü");
			editor.handleInput("\n"); // 换行。
			editor.handleInput("Ä");
			editor.handleInput("Ö");
			editor.handleInput("Ü");

			const text = editor.getText();
			assert.strictEqual(text, "äöü\nÄÖÜ");
		});

		it("replaces the entire document with unicode text via setText (paste simulation)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 模拟带括号粘贴或通过程序替换文本。
			editor.setText("Hällö Wörld! 😀 äöüÄÖÜß");

			const text = editor.getText();
			assert.strictEqual(text, "Hällö Wörld! 😀 äöüÄÖÜß");
		});

		it("moves cursor to document start on Ctrl+A and inserts at the beginning", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			editor.handleInput("x"); // 在行首插入字符。

			const text = editor.getText();
			assert.strictEqual(text, "xab");
		});

		it("deletes words correctly with Ctrl+W and Alt+Backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 基本的按词删除。
			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(editor.getText(), "foo bar ");

			// 删除末尾空白。
			editor.setText("foo bar   ");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo ");

			// 删除连续标点。
			editor.setText("foo bar...");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo bar");

			// Intl 的类词语分段中包含 ASCII 标点时，仍保留原有边界。
			editor.setText("foo.bar");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo.");

			editor.setText("foo:bar");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo:");

			// 跨多行删除。
			editor.setText("line one\nline two");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "line one\nline ");

			// 删除空行并合并相邻内容。
			editor.setText("line one\n");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "line one");

			// 保证字素簇完整性（将表情符号视为一个词）。
			editor.setText("foo 😀😀 bar");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo 😀😀 ");
			editor.handleInput("\x17");
			assert.strictEqual(editor.getText(), "foo ");

			// Alt+Backspace。
			editor.setText("foo bar");
			editor.handleInput("\x1b\x7f"); // Alt+退格键（旧版按键序列）。
			assert.strictEqual(editor.getText(), "foo ");
		});

		it("navigates words correctly with Ctrl+Left/Right", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo bar... baz");
			// 光标位于末尾。

			// 向左移过 baz。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 }); // 位于“...”之后。

			// 向左移过标点。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 位于“bar”之后。

			// 向左移过 bar。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 }); // 位于“foo ”之后。

			// 向右移过 bar。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 位于“bar”末尾。

			// 向右移过连续标点。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 }); // 位于“...”之后。

			// 向右移动时跳过空格并停在 baz 之后。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 14 }); // 位于行尾。

			// 验证从带前导空白的文本开头向后移动。
			editor.setText("   foo bar");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 }); // 位于“foo”之后。

			// Intl 的类词语分段中包含 ASCII 标点时，仍保留原有边界。
			editor.setText("foo.bar baz");
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left over baz
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left over bar
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left over .
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right over foo
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right over .
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right over bar
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });
		});

		it("stops at fullwidth Chinese punctuation (issue #4972)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 你好，世界 = 你好(0-2) ，(2-3) 世界(3-5)
			editor.setText("你好，世界");
			// 光标位于末尾（第 5 列）。

			// 向左移过“世界”。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 }); // 位于“，”之后。

			// 向左移过“，”。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 }); // 位于“你好”之后。

			// 向左移过“你好”。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // 位于行首。

			// 向右移过“你好”。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 }); // 位于“你好”之后。

			// 向右移过“，”。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 }); // 位于“，”之后。

			// 向右移过“世界”。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 }); // 位于行尾。
		});

		it("handles mixed CJK and ASCII word movement", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// "hello你好，world世界" = hello(0-5) 你好(5-7) ，(7-8) world(8-13) 世界(13-15)
			editor.setText("hello你好，world世界");
			// 光标位于末尾（第 15 列）。

			// 向左移过“世界”。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 13 }); // 位于“world”之后。

			// 向左移过 world。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 }); // 位于“，”之后。

			// 向左移过“，”。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 位于“你好”之后。

			// 向左移过“你好”。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 }); // 位于“hello”之后。

			// 向左移过 hello。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // 位于行首。

			// 从开头向后移动。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 }); // 位于“hello”之后。

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 位于“你好”之后。

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 }); // 位于“，”之后。

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 13 }); // 位于“world”之后。

			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 15 }); // end
		});
	});

	describe("Scroll indicators", () => {
		it("centers scroll indicators on wide borders", () => {
			const width = 40;
			const editor = new Editor(createTestTUI(width), defaultEditorTheme);
			editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));

			editor.render(width);
			for (let index = 0; index < 10; index++) editor.handleInput("\x1b[A");

			const lines = editor.render(width);
			assert.strictEqual(stripVTControlCharacters(lines[0]!), `${"─".repeat(15)} ↑ 9 more ${"─".repeat(15)}`);
			assert.strictEqual(stripVTControlCharacters(lines.at(-1)!), `${"─".repeat(15)} ↓ 4 more ${"─".repeat(15)}`);
		});

		it("keeps truncated scroll indicators within width and preserves their color (issue #6962)", () => {
			const width = 10;
			const borderColor = (text: string) => `\x1b[35m${text}\x1b[39m`;
			const editor = new Editor(createTestTUI(width), { ...defaultEditorTheme, borderColor });
			editor.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));

			// 先渲染一次以初始化换行，再移动光标，使视口上方和下方都保留内容。
			editor.render(width);
			for (let index = 0; index < 10; index++) editor.handleInput("\x1b[A");

			const lines = editor.render(width);
			const topBorder = lines[0]!;
			const bottomBorder = lines.at(-1)!;

			assert.match(stripVTControlCharacters(topBorder), /^─── ↑/);
			assert.match(stripVTControlCharacters(bottomBorder), /^─── ↓/);
			assert.strictEqual(topBorder, borderColor(stripVTControlCharacters(topBorder)));
			assert.strictEqual(bottomBorder, borderColor(stripVTControlCharacters(bottomBorder)));
			for (const line of lines) {
				assert.strictEqual(visibleWidth(line), width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
			}
		});
	});

	describe("Grapheme-aware text wrapping", () => {
		it("wraps lines correctly when text contains wide emojis", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 20;

			// ✅ 占 2 列，因此 "Hello ✅ World" 共占 14 列。
			editor.setText("Hello ✅ World");
			const lines = editor.render(width);

			// 所有内容行（边框之间的行）都应适配指定宽度。
			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}
		});

		it("wraps long text with emojis at correct positions", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 10;

			// 每个 ✅ 占 2 列。"✅✅✅✅✅" 共 10 列，恰好放满。
			// "✅✅✅✅✅✅" 共 12 列，需要换行。
			editor.setText("✅✅✅✅✅✅");
			const lines = editor.render(width);

			// 应有 2 行内容（另加上下 2 行边框）。
			// 第一行包含 5 个表情符号（10 列），第二行包含 1 个表情符号（2 列）及填充空格。
			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}
		});

		it("renders isolated Thai and Lao AM clusters without width drift", () => {
			for (const text of ["ำabc", "ຳabc"]) {
				const editor = new Editor(createTestTUI(), defaultEditorTheme);
				const width = 8;
				editor.setText(text);

				for (const line of editor.render(width)) {
					assert.strictEqual(visibleWidth(line), width, `line width drift for ${JSON.stringify(text)}: ${line}`);
				}
			}
		});

		it("wraps CJK characters correctly (each is 2 columns wide)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 10 + 1; // 额外预留 1 列用于显示光标。

			// 每个中日韩字符占 2 列。"日本語テスト" 共 6 个字符，占 12 列。
			editor.setText("日本語テスト");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}

			// 验证内容已正确拆分。
			const contentLines = lines.slice(1, -1).map((l) => stripTerminalSequences(l).trim());
			assert.strictEqual(contentLines.length, 2);
			assert.strictEqual(contentLines[0], "日本語テス"); // 5 个字符占 10 列。
			assert.strictEqual(contentLines[1], "ト"); // 1 char = 2 columns (+ padding)
		});

		it("handles mixed ASCII and wide characters in wrapping", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 15 + 1; // 额外预留 1 列用于显示光标。

			// "Test ✅ OK 日本" 占 4 + 1 + 2 + 1 + 2 + 1 + 4 = 15 列（恰好适配 width-1=15）。
			editor.setText("Test ✅ OK 日本");
			const lines = editor.render(width);

			// 应能放在同一行内容中。
			const contentLines = lines.slice(1, -1);
			assert.strictEqual(contentLines.length, 1);

			const lineWidth = visibleWidth(contentLines[0]!);
			assert.strictEqual(lineWidth, width);
		});

		it("renders cursor correctly on wide characters", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 20;

			editor.setText("A✅B");
			// 光标应位于末尾（B 之后）。
			const lines = editor.render(width);

			// 光标（反显空格）应可见。
			const contentLine = lines[1]!;
			assert.ok(contentLine.includes(FAKE_CURSOR_START), "Should have fake cursor");

			// 行宽仍应正确。
			assert.strictEqual(visibleWidth(contentLine), width);
		});

		it("does not exceed terminal width with emoji at wrap boundary", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 11;

			// "0123456789✅" 包含 10 个 ASCII 字符和一个占 2 列的表情符号，共 12 列。
			// 因为超出宽度，表情符号前应换行。
			editor.setText("0123456789✅");
			const lines = editor.render(width);

			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.ok(lineWidth <= width, `Line ${i} has width ${lineWidth}, exceeds max ${width}`);
			}
		});

		it("shows cursor at end of line before wrap, wraps on next char", () => {
			const width = 10;
			for (const paddingX of [0, 1]) {
				const editor = new Editor(createTestTUI(width + paddingX), defaultEditorTheme, { paddingX });

				// 输入 9 个字符，恰好占满 layoutWidth，光标位于同一行末尾。
				for (const ch of "aaaaaaaaa") editor.handleInput(ch);
				let lines = editor.render(width + paddingX);
				let contentLines = lines.slice(1, -1);
				assert.strictEqual(contentLines.length, 1, "Should be 1 content line before wrap");
				assert.ok(contentLines[0]!.endsWith(renderFakeCursor(" ")), "Cursor should be at end of line");

				// 再输入 1 个字符，文本应换到第二行。
				editor.handleInput("a");
				lines = editor.render(width + paddingX);
				contentLines = lines.slice(1, -1);
				assert.strictEqual(contentLines.length, 2, "Should wrap to 2 content lines");
			}
		});
	});

	describe("Word wrapping", () => {
		it("wraps at word boundaries instead of mid-word", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 40;

			editor.setText("Hello world this is a test of word wrapping functionality");
			const lines = editor.render(width);

			// 获取内容行（边框之间的行）。
			const contentLines = lines.slice(1, -1).map((l) => stripTerminalSequences(l).trim());

			// 不应在词语中间断行。
			// 第一行应以完整词语结尾。
			assert.ok(!contentLines[0]!.endsWith("-"), "Line should not end with hyphen (mid-word break)");

			// 每行内容都应由完整词语组成。
			for (const line of contentLines) {
				// 行尾的词语应完整，不能只显示部分内容。
				const lastChar = line.trimEnd().slice(-1);
				assert.ok(lastChar === "" || /[\w.,!?;:]/.test(lastChar), `Line ends unexpectedly with: "${lastChar}"`);
			}
		});

		it("does not start lines with leading whitespace after word wrap", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 20;

			editor.setText("Word1 Word2 Word3 Word4 Word5 Word6");
			const lines = editor.render(width);

			// 获取内容行（边框之间的行）。
			const contentLines = lines.slice(1, -1);

			// 行首不应有空白（行尾的填充空格除外）。
			for (let i = 0; i < contentLines.length; i++) {
				const line = stripVTControlCharacters(contentLines[i]!);
				const trimmedStart = line.trimStart();
				// 每行要么全是填充空格，要么以词语字符开头。
				if (trimmedStart.length > 0) {
					assert.ok(!/^\s+\S/.test(line.trimEnd()), `Line ${i} starts with unexpected whitespace before content`);
				}
			}
		});

		it("breaks long words (URLs) at character level", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 30;

			editor.setText("Check https://example.com/very/long/path/that/exceeds/width here");
			const lines = editor.render(width);

			// 所有行都应适配指定宽度。
			for (let i = 1; i < lines.length - 1; i++) {
				const lineWidth = visibleWidth(lines[i]!);
				assert.strictEqual(lineWidth, width, `Line ${i} has width ${lineWidth}, expected ${width}`);
			}
		});

		it("preserves multiple spaces within words on same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 50;

			editor.setText("Word1   Word2    Word3");
			const lines = editor.render(width);

			const contentLine = stripVTControlCharacters(lines[1]!).trim();
			// 多个连续空格应予保留。
			assert.ok(contentLine.includes("Word1   Word2"), "Multiple spaces should be preserved");
		});

		it("handles empty string", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 40;

			editor.setText("");
			const lines = editor.render(width);

			// 应包含边框、空内容行和另一条边框。
			assert.strictEqual(lines.length, 3);
		});

		it("handles single word that fits exactly", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const width = 10 + 1; // 额外预留 1 列用于显示光标。

			editor.setText("1234567890");
			const lines = editor.render(width);

			// 应恰好有 3 行：顶部边框、内容行和底部边框。
			assert.strictEqual(lines.length, 3);
			const contentLine = stripVTControlCharacters(lines[1]!);
			assert.ok(contentLine.includes("1234567890"), "Content should contain the word");
		});

		it("wraps word to next line when it ends exactly at terminal width", () => {
			// "hello "（6 个字符）+ "world"（5 个字符）= 11；但 "world" 末尾不是空白，正好到达宽度边界。
			// 因此应将其换到下一行。末尾空格保留在第一行的 "hello" 后面。
			const chunks = wordWrapLine("hello world test", 11);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "hello ");
			assert.strictEqual(chunks[1]!.text, "world test");
		});

		it("keeps whitespace at terminal width boundary on same line", () => {
			// "hello world " 恰好有 12 个字符（包括末尾空格）。
			// 第 12 个位置的空格应保留在第一行。
			const chunks = wordWrapLine("hello world test", 12);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "hello world ");
			assert.strictEqual(chunks[1]!.text, "test");
		});

		it("handles unbreakable word filling width exactly followed by space", () => {
			const chunks = wordWrapLine("aaaaaaaaaaaa aaaa", 12);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "aaaaaaaaaaaa");
			assert.strictEqual(chunks[1]!.text, " aaaa");
		});

		it("wraps word to next line when it fits width but not remaining space", () => {
			const chunks = wordWrapLine("      aaaaaaaaaaaa", 12);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "      ");
			assert.strictEqual(chunks[1]!.text, "aaaaaaaaaaaa");
		});

		it("keeps word with multi-space and following word together when they fit", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,    consectetur", 30);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,    consectetur");
		});

		it("keeps word with multi-space and following word when they fill width exactly", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,              consectetur", 30);

			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,              consectetur");
		});

		it("splits when word plus multi-space plus word exceeds width", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,               consectetur", 30);

			assert.strictEqual(chunks.length, 3);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,               ");
			assert.strictEqual(chunks[2]!.text, "consectetur");
		});

		it("breaks long whitespace at line boundary", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                         consectetur", 30);

			assert.strictEqual(chunks.length, 3);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,                         ");
			assert.strictEqual(chunks[2]!.text, "consectetur");
		});

		it("breaks long whitespace at line boundary 2", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                          consectetur", 30);

			assert.strictEqual(chunks.length, 3);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,                         ");
			assert.strictEqual(chunks[2]!.text, " consectetur");
		});

		it("breaks whitespace spanning full lines", () => {
			const chunks = wordWrapLine("Lorem ipsum dolor sit amet,                                     consectetur", 30);

			assert.strictEqual(chunks.length, 3);
			assert.strictEqual(chunks[0]!.text, "Lorem ipsum dolor sit ");
			assert.strictEqual(chunks[1]!.text, "amet,                         ");
			assert.strictEqual(chunks[2]!.text, "            consectetur");
		});

		it("force-breaks when wide char after word boundary wrap still overflows", () => {
			// " "（1 列）+ "a"*186（186 列）+ "你"（2 列）= 189 列可见宽度。
			// maxWidth = 187：回退到空格处会剩下 186 + 2 = 188 列，超过 187，
			// 因此算法必须改为在宽字符之前强制换行。
			const line = ` ${"a".repeat(186)}你`;
			const chunks = wordWrapLine(line, 187);

			for (const chunk of chunks) {
				assert.ok(
					visibleWidth(chunk.text) <= 187,
					`chunk "${chunk.text.slice(0, 20)}..." has visible width ${visibleWidth(chunk.text)}, expected <= 187`,
				);
			}
			// 验证内容没有丢失。
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("splits oversized atomic segment across multiple chunks", () => {
			// 通过传入预分段数据，模拟宽度超过 maxWidth 的粘贴标记。
			const marker = "[paste #1 +20 lines]"; // 共 21 个字符。
			const line = `A${marker}B`;
			const segments: Intl.SegmentData[] = [
				{ segment: "A", index: 0, input: line },
				{ segment: marker, index: 1, input: line },
				{ segment: "B", index: 1 + marker.length, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			// 每个分块都必须适配 maxWidth。
			for (const chunk of chunks) {
				assert.ok(
					visibleWidth(chunk.text) <= 10,
					`chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`,
				);
			}

			// 验证内容没有丢失。
			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("splits oversized atomic segment at start of line", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `${marker}B`;
			const segments: Intl.SegmentData[] = [
				{ segment: marker, index: 0, input: line },
				{ segment: "B", index: marker.length, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				assert.ok(visibleWidth(chunk.text) <= 10);
			}
			// "B" 会落在最后一行（可能单独显示，也可能与标记尾部一起显示）。
			assert.strictEqual(chunks[chunks.length - 1]!.text.includes("B"), true);

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("splits oversized atomic segment at end of line", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `A${marker}`;
			const segments: Intl.SegmentData[] = [
				{ segment: "A", index: 0, input: line },
				{ segment: marker, index: 1, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				assert.ok(visibleWidth(chunk.text) <= 10);
			}
			assert.strictEqual(chunks[0]!.text, "A");

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("splits consecutive oversized atomic segments", () => {
			const m1 = "[paste #1 +20 lines]"; // 共 21 个字符。
			const m2 = "[paste #2 +30 lines]"; // 共 21 个字符。
			const line = `${m1}${m2}`;
			const segments: Intl.SegmentData[] = [
				{ segment: m1, index: 0, input: line },
				{ segment: m2, index: m1.length, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			for (const chunk of chunks) {
				assert.ok(
					visibleWidth(chunk.text) <= 10,
					`chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`,
				);
			}

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});

		it("wraps normally after oversized atomic segment", () => {
			const marker = "[paste #1 +20 lines]"; // 21 chars
			const line = `${marker} hello world`;
			const segments: Intl.SegmentData[] = [
				{ segment: marker, index: 0, input: line },
				{ segment: " ", index: marker.length, input: line },
				{ segment: "h", index: marker.length + 1, input: line },
				{ segment: "e", index: marker.length + 2, input: line },
				{ segment: "l", index: marker.length + 3, input: line },
				{ segment: "l", index: marker.length + 4, input: line },
				{ segment: "o", index: marker.length + 5, input: line },
				{ segment: " ", index: marker.length + 6, input: line },
				{ segment: "w", index: marker.length + 7, input: line },
				{ segment: "o", index: marker.length + 8, input: line },
				{ segment: "r", index: marker.length + 9, input: line },
				{ segment: "l", index: marker.length + 10, input: line },
				{ segment: "d", index: marker.length + 11, input: line },
			];

			const chunks = wordWrapLine(line, 10, segments);

			// 所有分块都必须适配指定宽度。
			for (const chunk of chunks) {
				assert.ok(
					visibleWidth(chunk.text) <= 10,
					`chunk "${chunk.text}" has visible width ${visibleWidth(chunk.text)}, expected <= 10`,
				);
			}

			// 最后一个分块应包含 "world"（之后恢复正常换行）。
			assert.strictEqual(chunks[chunks.length - 1]!.text, "world");

			const reconstructed = chunks.map((c) => line.slice(c.startIndex, c.endIndex)).join("");
			assert.strictEqual(reconstructed, line);
		});
	});

	describe("Kill ring", () => {
		it("Ctrl+W saves deleted text to kill ring and Ctrl+Y yanks it", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W 删除 "baz"。
			assert.strictEqual(editor.getText(), "foo bar ");

			// 移至开头并粘贴剪切环内容。
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "bazfoo bar ");
		});

		it("Ctrl+U saves deleted text to kill ring", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			// 将光标移至中间。
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			editor.handleInput("\x1b[C"); // 向右移动 5 次。
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[C"); // 再向右移动一列。

			editor.handleInput("\x15"); // Ctrl+U 删除 "hello "。
			assert.strictEqual(editor.getText(), "world");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("Ctrl+K saves deleted text to kill ring", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			editor.handleInput("\x0b"); // Ctrl+K 删除 "hello world"。

			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("Ctrl+Y does nothing when kill ring is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("test");
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "test");
		});

		it("Alt+Y cycles through kill ring after Ctrl+Y", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 创建包含多个条目的剪切环。
			editor.setText("first");
			editor.handleInput("\x17"); // Ctrl+W 删除 "first"。
			editor.setText("second");
			editor.handleInput("\x17"); // Ctrl+W 删除 "second"。
			editor.setText("third");
			editor.handleInput("\x17"); // Ctrl+W 删除 "third"。

			// 此时剪切环内容为：[first, second, third]。
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x19"); // Ctrl+Y 粘贴 "third" (most recent)。
			assert.strictEqual(editor.getText(), "third");

			editor.handleInput("\x1by"); // Alt+Y 切换到“second”。
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("\x1by"); // Alt+Y 切换到“first”。
			assert.strictEqual(editor.getText(), "first");

			editor.handleInput("\x1by"); // Alt+Y：循环回到“third”。
			assert.strictEqual(editor.getText(), "third");
		});

		it("Alt+Y does nothing if not preceded by yank", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("test");
			editor.handleInput("\x17"); // Ctrl+W 删除 "test"。
			editor.setText("other");

			// 输入字符以打断连续粘贴链。
			editor.handleInput("x");
			assert.strictEqual(editor.getText(), "otherx");

			// Alt+Y 不应执行任何操作。
			editor.handleInput("\x1by"); // Alt+Y
			assert.strictEqual(editor.getText(), "otherx");
		});

		it("Alt+Y does nothing if kill ring has ≤1 entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("only");
			editor.handleInput("\x17"); // Ctrl+W 删除 "only"。

			editor.handleInput("\x19"); // Ctrl+Y 粘贴 "only"。
			assert.strictEqual(editor.getText(), "only");

			editor.handleInput("\x1by"); // Alt+Y 不应执行任何操作。
			assert.strictEqual(editor.getText(), "only");
		});

		it("consecutive Ctrl+W accumulates into one kill ring entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("one two three");
			editor.handleInput("\x17"); // Ctrl+W 删除 "three"。
			editor.handleInput("\x17"); // Ctrl+W 删除前置的 "two "。
			editor.handleInput("\x17"); // Ctrl+W 删除前置的 "one "。

			assert.strictEqual(editor.getText(), "");

			// 所有删除内容应合并为一个条目。
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "one two three");
		});

		it("Ctrl+U accumulates multiline deletes including newlines", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 以多行文本开始，光标位于末尾。
			editor.setText("line1\nline2\nline3");
			// 光标位于第三行末尾（第 2 行，第 5 列）。

			// 删除 "line3"。
			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "line1\nline2\n");

			// 删除换行符（光标位于第二行空行开头，删除后与第一行合并）。
			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "line1\nline2");

			// 删除 "line2"。
			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "line1\n");

			// 删除换行符。
			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "line1");

			// 删除 "line1"。
			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "");

			// 所有删除内容都合并为一个条目："line1\nline2\nline3"。
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
		});

		it("backward deletions prepend, forward deletions append during accumulation", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("prefix|suffix");
			// 将光标放在 | 的位置。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // 向右移动 6 次。

			editor.handleInput("\x0b"); // Ctrl+K 删除 "suffix" (forward)。
			editor.handleInput("\x0b"); // Ctrl+K 删除 "|" (forward, appended)。
			assert.strictEqual(editor.getText(), "prefix");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "prefix|suffix");
		});

		it("non-delete actions break kill accumulation", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 删除 "baz"，再输入 "x" 打断累积，最后删除 "x"。
			editor.setText("foo bar baz");
			editor.handleInput("\x17"); // Ctrl+W 删除 "baz"。
			assert.strictEqual(editor.getText(), "foo bar ");

			editor.handleInput("x"); // 输入字符会中断连续累积。
			assert.strictEqual(editor.getText(), "foo bar x");

			editor.handleInput("\x17"); // Ctrl+W 删除“x”，并单独保存为一项，不与前项合并。
			assert.strictEqual(editor.getText(), "foo bar ");

			// 粘贴最近删除的内容，应为 "x"，而不是 "xbaz"。
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "foo bar x");

			// 切换到上一个条目，应为单独保存的 "baz"。
			editor.handleInput("\x1by"); // Alt+Y
			assert.strictEqual(editor.getText(), "foo bar baz");
		});

		it("non-yank actions break Alt+Y chain", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("first");
			editor.handleInput("\x17"); // Ctrl+W
			editor.setText("second");
			editor.handleInput("\x17"); // Ctrl+W
			editor.setText("");

			editor.handleInput("\x19"); // Ctrl+Y 粘贴 "second"。
			assert.strictEqual(editor.getText(), "second");

			editor.handleInput("x"); // 输入字符会中断连续粘贴链。
			assert.strictEqual(editor.getText(), "secondx");

			editor.handleInput("\x1by"); // Alt+Y 不应执行任何操作。
			assert.strictEqual(editor.getText(), "secondx");
		});

		it("kill ring rotation persists after cycling", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("first");
			editor.handleInput("\x17"); // 删除“first”。
			editor.setText("second");
			editor.handleInput("\x17"); // 删除“second”。
			editor.setText("third");
			editor.handleInput("\x17"); // 删除“third”。
			editor.setText("");

			// 剪切环内容：[first, second, third]。

			editor.handleInput("\x19"); // Ctrl+Y 粘贴 "third"。
			editor.handleInput("\x1by"); // Alt+Y 切换到“second”，剪切环随之轮转。

			// 此时剪切环内容为：[third, first, second]。
			assert.strictEqual(editor.getText(), "second");

			// 执行其他操作。
			editor.handleInput("x");
			editor.setText("");

			// 新的粘贴操作应取得 "second"（旋转后它位于环尾）。
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "second");
		});

		it("consecutive deletions across lines coalesce into one entry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 光标位于 "1\n2\n3" 末尾，按 Ctrl+W 删除全部内容。
			editor.setText("1\n2\n3");
			editor.handleInput("\x17"); // Ctrl+W 删除 "3"。
			assert.strictEqual(editor.getText(), "1\n2\n");

			editor.handleInput("\x17"); // Ctrl+W 删除换行符并与上一行合并。
			assert.strictEqual(editor.getText(), "1\n2");

			editor.handleInput("\x17"); // Ctrl+W 删除 "2"。
			assert.strictEqual(editor.getText(), "1\n");

			editor.handleInput("\x17"); // Ctrl+W 删除换行符。
			assert.strictEqual(editor.getText(), "1");

			editor.handleInput("\x17"); // Ctrl+W 删除 "1"。
			assert.strictEqual(editor.getText(), "");

			// 所有删除内容都应累积为一个条目。
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "1\n2\n3");
		});

		it("Ctrl+K at line end deletes newline and coalesces", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 第 1 行为 "ab"，第 2 行为 "cd"，光标位于第 1 行末尾。
			editor.setText("");
			editor.handleInput("a");
			editor.handleInput("b");
			editor.handleInput("\n");
			editor.handleInput("c");
			editor.handleInput("d");
			// 移至第一行末尾。
			editor.handleInput("\x1b[A"); // 按向上键。
			editor.handleInput("\x05"); // Ctrl+E：移至行尾。

			// 此时光标位于 "ab" 末尾，Ctrl+K 应删除换行符并与 "cd" 合并。
			editor.handleInput("\x0b"); // Ctrl+K 删除 newline。
			assert.strictEqual(editor.getText(), "abcd");

			// 继续删除。
			editor.handleInput("\x0b"); // Ctrl+K 删除 "cd"。
			assert.strictEqual(editor.getText(), "ab");

			// 两次删除都应累积到同一个条目中。
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "ab\ncd");
		});

		it("handles yank in middle of text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("word");
			editor.handleInput("\x17"); // Ctrl+W 删除 "word"。
			editor.setText("hello world");

			// 移至中间（"hello " 之后）。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello wordworld");
		});

		it("handles yank-pop in middle of text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 创建两个剪切环条目。
			editor.setText("FIRST");
			editor.handleInput("\x17"); // Ctrl+W 删除 "FIRST"。
			editor.setText("SECOND");
			editor.handleInput("\x17"); // Ctrl+W 删除 "SECOND"。

			// 剪切环内容：["FIRST", "SECOND"]。

			// 设置文本 "hello world"，并将光标放在 "hello " 之后。
			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // 向右移动 6 次。

			// 在中间粘贴 "SECOND"。
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello SECONDworld");

			// Yank-pop 将 "SECOND" 替换为 "FIRST"。
			editor.handleInput("\x1by"); // Alt+Y
			assert.strictEqual(editor.getText(), "hello FIRSTworld");
		});

		it("multiline yank and yank-pop in middle of text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 创建单行条目。
			editor.setText("SINGLE");
			editor.handleInput("\x17"); // Ctrl+W 删除 "SINGLE"。

			// 连续按 Ctrl+U 创建多行条目。
			editor.setText("A\nB");
			editor.handleInput("\x15"); // Ctrl+U 删除 "B"。
			editor.handleInput("\x15"); // Ctrl+U 删除 newline。
			editor.handleInput("\x15"); // Ctrl+U 删除 "A"。
			// 剪切环内容：["SINGLE", "A\nB"]。

			// 在 "hello world" 中间插入内容。
			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C");

			// 粘贴多行内容 "A\nB"。
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello A\nBworld");

			// Yank-pop 将其替换为 "SINGLE"。
			editor.handleInput("\x1by"); // Alt+Y
			assert.strictEqual(editor.getText(), "hello SINGLEworld");
		});

		it("Alt+D deletes word forward and saves to kill ring", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world test");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。

			editor.handleInput("\x1bd"); // Alt+D 删除“hello”。
			assert.strictEqual(editor.getText(), " world test");

			editor.handleInput("\x1bd"); // Alt+D 删除“ world”（跳过空白后再删除单词）。
			assert.strictEqual(editor.getText(), " test");

			// 粘贴操作应取得累积的文本。
			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "hello world test");
		});

		it("Alt+D at end of line deletes newline", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("line1\nline2");
			// 移至文档开头，再移到第一行末尾。
			editor.handleInput("\x1b[A"); // 按向上键移至第一行。
			editor.handleInput("\x05"); // Ctrl+E：移至行尾。

			editor.handleInput("\x1bd"); // Alt+D 删除换行符并合并两行。
			assert.strictEqual(editor.getText(), "line1line2");

			editor.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(editor.getText(), "line1\nline2");
		});
	});

	describe("Undo", () => {
		it("does nothing when undo stack is empty", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "");
		});

		it("coalesces consecutive word characters into one undo unit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello world");

			// 撤销会删除 " world"（空格前保存了状态，因此恢复为 "hello"）。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello");

			// 撤销会删除 "hello"。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "");
		});

		it("undoes spaces one at a time", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput(" ");
			assert.strictEqual(editor.getText(), "hello  ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销，并移除第二个空格。
			assert.strictEqual(editor.getText(), "hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销，并移除第一个空格。
			assert.strictEqual(editor.getText(), "hello");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销，并移除“hello”。
			assert.strictEqual(editor.getText(), "");
		});

		it("undoes newlines and signals next word to capture state", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\n");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello\nworld");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello\n");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "");
		});

		it("undoes backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\x7f"); // 退格键。
			assert.strictEqual(editor.getText(), "hell");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello");
		});

		it("undoes forward delete", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			editor.handleInput("\x1b[C"); // 右方向键。
			editor.handleInput("\x1b[3~"); // Delete 键。
			assert.strictEqual(editor.getText(), "hllo");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello");
		});

		it("undoes Ctrl+W (delete word backward)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(editor.getText(), "hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("undoes Ctrl+K (delete to line end)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // 向右移动 6 次。

			editor.handleInput("\x0b"); // Ctrl+K
			assert.strictEqual(editor.getText(), "hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello |world");
		});

		it("undoes Ctrl+U (delete to line start)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // 向右移动 6 次。

			editor.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(editor.getText(), "world");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("undoes yank", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("\x17"); // Ctrl+W：删除“hello ”。
			editor.handleInput("\x19"); // Ctrl+Y：粘贴剪切环中的内容。
			assert.strictEqual(editor.getText(), "hello ");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "");
		});

		it("undoes single-line paste atomically", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // 向右移动 5 次，使光标位于“hello”之后、空格之前。

			// 模拟带括号粘贴 "beep boop"。
			editor.handleInput("\x1b[200~beep boop\x1b[201~");
			assert.strictEqual(editor.getText(), "hellobeep boop world");

			// 撤销一次应恢复粘贴前的全部状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello| world");
		});

		it("does not trigger autocomplete during single-line paste", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async () => {
					suggestionCalls += 1;
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);
			editor.handleInput("\x1b[200~look at @node_modules/react/index.js please\x1b[201~");

			assert.strictEqual(editor.getText(), "look at @node_modules/react/index.js please");
			assert.strictEqual(suggestionCalls, 0);
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("decodes CSI-u Ctrl+letter sequences inside bracketed paste (tmux popup)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// tmux 弹出窗口在 extended-keys-format=csi-u 模式下，会将粘贴内容中的 \n 重新编码为
			// \x1b[106;5u（Ctrl+J）。如果不先解码，逐字符过滤器会移除 ESC，导致 "[106;5u" 泄漏到行间。参见 issue #3599。
			editor.handleInput("\x1b[200~line1\x1b[106;5uline2\x1b[106;5uline3\x1b[201~");
			assert.strictEqual(editor.getText(), "line1\nline2\nline3");
		});

		it("undoes multi-line paste atomically", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // 向右移动 5 次，使光标位于“hello”之后、空格之前。

			// 模拟带括号粘贴多行文本。
			editor.handleInput("\x1b[200~line1\nline2\nline3\x1b[201~");
			assert.strictEqual(editor.getText(), "helloline1\nline2\nline3 world");

			// 撤销一次应恢复粘贴前的全部状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello| world");
		});

		it("undoes insertTextAtCursor atomically", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // 向右移动 5 次，使光标位于“hello”之后、空格之前。

			// 通过程序插入文本（例如剪贴板中的图片路径）。
			editor.insertTextAtCursor("/tmp/image.png");
			assert.strictEqual(editor.getText(), "hello/tmp/image.png world");

			// 撤销一次应恢复插入前的全部状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello| world");
		});

		it("insertTextAtCursor handles multiline text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C"); // 向右移动 5 次，使光标位于“hello”之后、空格之前。

			// 插入多行文本。
			editor.insertTextAtCursor("line1\nline2\nline3");
			assert.strictEqual(editor.getText(), "helloline1\nline2\nline3 world");

			// 光标应位于插入文本末尾（"line3" 之后、" world" 之前）。
			const cursor = editor.getCursor();
			assert.strictEqual(cursor.line, 2);
			assert.strictEqual(cursor.col, 5); // "line3".length

			// 撤销一次应恢复插入前的全部状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("insertTextAtCursor normalizes CRLF and CR line endings", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("");

			// 插入包含 CRLF 的文本。
			editor.insertTextAtCursor("a\r\nb\r\nc");
			assert.strictEqual(editor.getText(), "a\nb\nc");

			editor.handleInput("\x1b[45;5u"); // Undo
			assert.strictEqual(editor.getText(), "");

			// 插入仅包含 CR 的文本。
			editor.insertTextAtCursor("x\ry\rz");
			assert.strictEqual(editor.getText(), "x\ny\nz");
		});

		it("undoes setText to empty string", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello world");

			editor.setText("");
			assert.strictEqual(editor.getText(), "");

			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello world");
		});

		it("clears undo stack on submit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("\r"); // Enter - submit

			assert.strictEqual(submitted, "hello");
			assert.strictEqual(editor.getText(), "");

			// 撤销操作应无效，因为撤销栈已清空。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "");
		});

		it("exits history browsing mode on undo", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 将 "hello" 添加到历史记录。
			editor.addToHistory("hello");
			assert.strictEqual(editor.getText(), "");

			// 输入 "world"。
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "world");

			// 按 Ctrl+W 删除一个词。
			editor.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(editor.getText(), "");

			// 按向上键进入历史记录浏览模式，显示 "hello"。
			editor.handleInput("\x1b[A"); // 按向上键。
			assert.strictEqual(editor.getText(), "hello");

			// 撤销应恢复为空文本（进入历史记录浏览模式之前的状态）。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "");

			// 再撤销一次应恢复为 "world"（按 Ctrl+W 之前的状态）。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "world");
		});

		it("undo restores to pre-history state even after multiple history navigations", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 添加历史记录条目。
			editor.addToHistory("first");
			editor.addToHistory("second");
			editor.addToHistory("third");

			// 输入一些内容。
			editor.handleInput("c");
			editor.handleInput("u");
			editor.handleInput("r");
			editor.handleInput("r");
			editor.handleInput("e");
			editor.handleInput("n");
			editor.handleInput("t");
			assert.strictEqual(editor.getText(), "current");

			// 清空编辑器。
			editor.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(editor.getText(), "");

			// 多次浏览历史记录。
			editor.handleInput("\x1b[A"); // 按向上键选中“third”。
			assert.strictEqual(editor.getText(), "third");
			editor.handleInput("\x1b[A"); // 按向上键选中“second”。
			assert.strictEqual(editor.getText(), "second");
			editor.handleInput("\x1b[A"); // 按向上键选中“first”。
			assert.strictEqual(editor.getText(), "first");

			// 撤销应恢复为空文本（开始浏览前的状态），而不是中间状态。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "");

			// 再撤销一次应恢复为 "current"。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "current");
		});

		it("cursor movement starts new undo unit", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput(" ");
			editor.handleInput("w");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("l");
			editor.handleInput("d");
			assert.strictEqual(editor.getText(), "hello world");

			// 将光标向左移动 5 次（移至 "hello " 之后）。
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[D");

			// 在中间输入 "lol"。
			editor.handleInput("l");
			editor.handleInput("o");
			editor.handleInput("l");
			assert.strictEqual(editor.getText(), "hello lolworld");

			// 撤销应恢复为 "hello world"（插入 "lol" 之前的状态）。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello world");

			editor.handleInput("|");
			assert.strictEqual(editor.getText(), "hello |world");
		});

		it("no-op delete operations do not push undo snapshots", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.handleInput("h");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput("l");
			editor.handleInput("o");
			assert.strictEqual(editor.getText(), "hello");

			// 在空文本上多次执行删除词语操作（这些操作应无效）。
			editor.handleInput("\x17"); // Ctrl+W 删除 "hello"。
			assert.strictEqual(editor.getText(), "");
			editor.handleInput("\x17"); // Ctrl+W：不执行任何操作（没有内容可删除）。
			editor.handleInput("\x17"); // Ctrl+W：不执行任何操作。

			// 撤销一次应恢复为 "hello"。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "hello");
		});

		it("undoes autocomplete", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 创建一个模拟自动补全提供器。
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix === "di") {
						return {
							items: [{ value: "dist/", label: "dist/" }],
							prefix: "di",
						};
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 "di"。
			editor.handleInput("d");
			editor.handleInput("i");
			assert.strictEqual(editor.getText(), "di");

			// 按 Tab 键触发自动补全。
			editor.handleInput("\t");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "dist/");
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			// 撤销应恢复为 "di"。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "di");
		});
	});

	describe("Autocomplete", () => {
		it("triggers and debounces symbol completion after CJK punctuation", async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			for (const before of [
				"查看，",
				"\u3000",
				..."，．：；！？（）［］｛｝“”‘’…—。、「」『』《》【】",
				"(",
				"see (",
				"`",
				"[",
			]) {
				for (const trigger of ["@", "#", "$", "-"]) {
					const editor = new Editor(createTestTUI(), defaultEditorTheme);
					const requests: string[] = [];
					editor.setAutocompleteProvider({
						triggerCharacters: ["$", "-"],
						getSuggestions: async (lines, cursorLine, cursorCol) => {
							requests.push(lines[cursorLine]!.slice(0, cursorCol));
							return null;
						},
						applyCompletion,
					});
					editor.setText(before);
					editor.handleInput(trigger);
					t.mock.timers.tick(19);
					await flushAutocomplete();
					assert.deepStrictEqual(requests, []);
					t.mock.timers.tick(1);
					await flushAutocomplete();
					assert.deepStrictEqual(requests, [before + trigger]);

					editor.handleInput("r");
					editor.handleInput("e");
					t.mock.timers.tick(19);
					await flushAutocomplete();
					assert.strictEqual(requests.length, 1);
					t.mock.timers.tick(1);
					await flushAutocomplete();
					assert.deepStrictEqual(requests, [before + trigger, `${before}${trigger}re`]);
				}
			}
		});

		it("does not auto-trigger after CJK letters or for unprefixed paths", async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let requests = 0;
			editor.setAutocompleteProvider({
				getSuggestions: async () => {
					requests++;
					return null;
				},
				applyCompletion,
			});
			for (const text of [
				"user@example.com",
				"张三@example.com",
				"查看@src",
				"あ@src",
				"カ@src",
				"한@src",
				"ㄅ@src",
				"𠮷@src",
				"か\u3099@src",
				"禰\u{e0100}@src",
				"々@src",
				"Ａ@src",
				"文档@备份",
				"prefix#123",
				"foo(@src",
				"问题#123",
				"查看，/path/",
				"查看，./文档/",
				"src/index.ts",
				"./文档/说明.md",
				"文档/说明.md",
				"查看src/index.ts",
			]) {
				editor.setText("");
				for (const char of text) editor.handleInput(char);
				t.mock.timers.tick(20);
				await flushAutocomplete();
				assert.strictEqual(requests, 0, text);
			}
		});

		it("requests path completion after CJK punctuation only on Tab", async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const requests: Array<{ text: string; force: boolean | undefined }> = [];
			editor.setAutocompleteProvider({
				getSuggestions: async (lines, cursorLine, cursorCol, options) => {
					requests.push({ text: lines[cursorLine]!.slice(0, cursorCol), force: options.force });
					return null;
				},
				applyCompletion,
			});
			const text = "查看，/path/";
			for (const char of text) editor.handleInput(char);
			t.mock.timers.tick(20);
			await flushAutocomplete();
			assert.deepStrictEqual(requests, []);
			editor.handleInput("\t");
			await flushAutocomplete();
			assert.deepStrictEqual(requests, [{ text, force: true }]);
		});

		it("completes Chinese path prefixes after whitespace or CJK punctuation with Tab", async (t) => {
			const baseDir = mkdtempSync(join(tmpdir(), "pi-editor-autocomplete-"));
			t.after(() => rmSync(baseDir, { recursive: true, force: true }));
			mkdirSync(join(baseDir, "文档"));
			writeFileSync(join(baseDir, "文档", "说明.md"), "text");
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.setAutocompleteProvider(new CombinedAutocompleteProvider([], baseDir));
			for (const separator of [" ", "\t", "\u3000", "\u00a0", "，", "。"]) {
				editor.setText(`查看${separator}`);
				const before = editor.getText();
				editor.handleInput("文");
				editor.handleInput("\t");
				await flushAutocomplete();
				assert.strictEqual(editor.getText(), `${before}文档/`);
				editor.handleInput("说");
				editor.handleInput("\t");
				await flushAutocomplete();
				assert.strictEqual(editor.getText(), `${before}文档/说明.md`);
				assert.deepStrictEqual(editor.getCursor(), { line: 0, col: editor.getText().length });
			}
		});

		it("ends unquoted trigger and debounce contexts at whitespace or CJK punctuation", async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			for (const separator of [" ", "\u3000", "，", "。"]) {
				for (const trigger of ["@", "#", "$"]) {
					const editor = new Editor(createTestTUI(), defaultEditorTheme);
					const requests: string[] = [];
					const prefix = `${trigger}src`;
					editor.setAutocompleteProvider({
						triggerCharacters: ["$"],
						getSuggestions: async (lines, cursorLine, cursorCol) => {
							const text = lines[cursorLine]!.slice(0, cursorCol);
							requests.push(text);
							return text === prefix ? { prefix, items: [{ value: `${prefix}/`, label: "src/" }] } : null;
						},
						applyCompletion,
					});
					editor.setText(`${trigger}sr`);
					editor.handleInput("c");
					t.mock.timers.tick(20);
					await flushAutocomplete();
					assert.strictEqual(editor.isShowingAutocomplete(), true);
					editor.handleInput(separator);
					await flushAutocomplete();
					assert.deepStrictEqual(requests, [prefix, prefix + separator]);
					assert.strictEqual(editor.isShowingAutocomplete(), false);
					editor.handleInput("文");
					t.mock.timers.tick(20);
					await flushAutocomplete();
					assert.deepStrictEqual(requests, [prefix, prefix + separator]);
				}
			}
		});

		it("re-triggers CJK path completion after accepting directories and deleting", async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const provider = new CombinedAutocompleteProvider([], process.cwd());
			for (const directory of ["文档", "我的 文档", "资料，归档"]) {
				const quoted = directory !== "文档";
				const initial = quoted ? `@"${directory.slice(0, 2)}` : "@文";
				const directoryValue = quoted ? `@"${directory}/"` : `@${directory}/`;
				const fileValue = quoted ? `@"${directory}/说明.md"` : `@${directory}/说明.md`;
				const filePrefix = quoted ? `@"${directory}/说` : `@${directory}/说`;
				const editor = new Editor(createTestTUI(), defaultEditorTheme);
				editor.setAutocompleteProvider({
					getSuggestions: async (lines, cursorLine, cursorCol) => {
						const before = lines[cursorLine]!.slice(0, cursorCol);
						const prefix = before.slice(before.indexOf("@"));
						if (prefix === initial) {
							return { prefix, items: [{ value: directoryValue, label: `${directory}/` }] };
						}
						return prefix === filePrefix ? { prefix, items: [{ value: fileValue, label: "说明.md" }] } : null;
					},
					applyCompletion: (...args) => provider.applyCompletion(...args),
				});
				editor.setText(`查看：${initial}`);
				editor.handleInput("\t");
				await flushAutocomplete();
				assert.strictEqual(editor.getText(), `查看：${directoryValue}`);
				assert.strictEqual(editor.isShowingAutocomplete(), false);

				editor.handleInput("说");
				t.mock.timers.tick(20);
				await flushAutocomplete();
				assert.strictEqual(editor.isShowingAutocomplete(), true);

				for (const deletion of ["\x7f", "\x1b[3~"]) {
					editor.handleInput("错");
					t.mock.timers.tick(20);
					await flushAutocomplete();
					assert.strictEqual(editor.isShowingAutocomplete(), false);
					if (deletion === "\x1b[3~") editor.handleInput("\x1b[D");
					editor.handleInput(deletion);
					t.mock.timers.tick(20);
					await flushAutocomplete();
					assert.strictEqual(editor.isShowingAutocomplete(), true);
				}

				editor.handleInput("\t");
				assert.strictEqual(editor.getText(), `查看：${fileValue} `);
				assert.deepStrictEqual(editor.getCursor(), { line: 0, col: editor.getText().length });
			}
		});

		it("auto-applies single force-file suggestion without showing menu", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					if (!options.force) {
						return null;
					}
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix === "Work") {
						return {
							items: [{ value: "Workspace/", label: "Workspace/" }],
							prefix: "Work",
						};
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 "Work"。
			editor.handleInput("W");
			editor.handleInput("o");
			editor.handleInput("r");
			editor.handleInput("k");
			assert.strictEqual(editor.getText(), "Work");

			// 按 Tab 键应直接应用补全，而不显示菜单。
			editor.handleInput("\t");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "Workspace/");
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			// 撤销应恢复为 "Work"。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "Work");
		});

		it("shows menu when force-file has multiple suggestions", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					if (!options.force) {
						return null;
					}
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					if (prefix === "src") {
						return {
							items: [
								{ value: "src/", label: "src/" },
								{ value: "src.txt", label: "src.txt" },
							],
							prefix: "src",
						};
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 "src"。
			editor.handleInput("s");
			editor.handleInput("r");
			editor.handleInput("c");
			assert.strictEqual(editor.getText(), "src");

			// 有多个建议，因此按 Tab 键应显示菜单。
			editor.handleInput("\t");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "src");
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 再按一次 Tab 键以接受第一条建议。
			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), "src/");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("keeps suggestions open when typing in force mode (Tab-triggered)", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const allFiles = [
				{ value: "readme.md", label: "readme.md" },
				{ value: "package.json", label: "package.json" },
				{ value: "src/", label: "src/" },
				{ value: "dist/", label: "dist/" },
			];

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol, options) => {
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					const shouldMatch = options.force || prefix.includes("/") || prefix.startsWith(".");
					if (!shouldMatch) {
						return null;
					}
					const filtered = allFiles.filter((f) => f.value.toLowerCase().startsWith(prefix.toLowerCase()));
					if (filtered.length > 0) {
						return { items: filtered, prefix };
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 在空提示符处按 Tab 键，应显示所有文件（强制模式）。
			editor.handleInput("\t");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 输入 "r" 后应筛选出 "readme.md"（强制模式会保持建议列表打开）。
			editor.handleInput("r");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "r");
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 输入 "e" 后仍应显示 "readme.md"。
			editor.handleInput("e");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "re");
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 按 Tab 键接受建议。
			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), "readme.md");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("debounces @ autocomplete while typing", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					suggestionCalls += 1;
					const text = (lines[0] || "").slice(0, cursorCol);
					return {
						items: [{ value: "@main.ts", label: "main.ts" }],
						prefix: text,
					};
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("@");
			editor.handleInput("m");
			editor.handleInput("a");
			editor.handleInput("i");

			assert.strictEqual(suggestionCalls, 0);
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			assert.strictEqual(suggestionCalls, 1);
			assert.strictEqual(editor.isShowingAutocomplete(), true);
		});

		it("re-queries the autocomplete picker when the cursor moves back into the command name", async () => {
			// earendil-works/pi#5496 回归测试：从斜杠命令的参数区域向左移动光标时，必须重新查询选择器，
			// 不能继续显示过期的参数列表。修复前，moveCursor() 不会调用 updateAutocomplete()，
			// 因此在 `/cmd `（参数菜单）处按左键后，仍会针对 `/cmd` 前缀显示参数，
			// 此时按 Tab 会把过期建议拼接到不完整的命令名称后。
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const before = (lines[0] || "").slice(0, cursorCol);
					if (!before.startsWith("/")) return null;
					// 光标已越过命令名（光标前有空格）：提供参数建议。
					if (before.includes(" ")) {
						return {
							items: [
								{ value: "repo", label: "repo" },
								{ value: "message", label: "message" },
								{ value: "help", label: "help" },
							],
							prefix: before.slice(before.indexOf(" ") + 1),
						};
					}
					// 光标仍在命令名中：仅提供命令名建议。
					return { items: [{ value: "cmd", label: "cmd" }], prefix: before };
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 `/cmd `，使选择器显示参数列表。
			for (const ch of "/cmd ") {
				editor.handleInput(ch);
				await flushAutocomplete();
			}
			assert.strictEqual(editor.getText(), "/cmd ");
			assert.strictEqual(editor.isShowingAutocomplete(), true);
			const atArg = editor
				.render(80)
				.map((l) => stripVTControlCharacters(l))
				.join("\n");
			assert.ok(atArg.includes("repo"), "argument menu should be visible at `/cmd `");

			// 按左方向键，将光标移回命令名（`/cmd`）内。
			editor.handleInput("\x1b[D");
			await flushAutocomplete();

			// 选择器必须重新查询：过期的参数项应已消失
			//（被命令名建议替换，或选择器已关闭）。
			const afterMove = editor
				.render(80)
				.map((l) => stripVTControlCharacters(l))
				.join("\n");
			assert.ok(!afterMove.includes("repo"), "stale argument menu must not survive the cursor move");
			assert.ok(!afterMove.includes("message"), "stale argument menu must not survive the cursor move");
		});

		it("debounces # autocomplete while typing", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					suggestionCalls += 1;
					const text = (lines[0] || "").slice(0, cursorCol);
					return {
						items: [{ value: "#2983", label: "#2983" }],
						prefix: text,
					};
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("#");
			editor.handleInput("2");
			editor.handleInput("9");
			editor.handleInput("8");

			assert.strictEqual(suggestionCalls, 0);
			assert.strictEqual(editor.isShowingAutocomplete(), false);

			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			assert.strictEqual(suggestionCalls, 1);
			assert.strictEqual(editor.isShowingAutocomplete(), true);
		});

		it("debounces custom triggerCharacters autocomplete while typing", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			editor.setAutocompleteProvider({
				triggerCharacters: ["$"],
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					suggestionCalls += 1;
					const prefix = (lines[0] || "").slice(0, cursorCol);
					return { items: [{ value: "$skill-name", label: "skill-name" }], prefix };
				},
				applyCompletion,
			});

			editor.handleInput("$");
			editor.handleInput("s");
			editor.handleInput("k");

			assert.strictEqual(suggestionCalls, 0);
			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			assert.strictEqual(suggestionCalls, 1);
			assert.strictEqual(editor.isShowingAutocomplete(), true);
		});

		it("resets custom triggerCharacters when provider changes", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let suggestionCalls = 0;

			editor.setAutocompleteProvider({
				triggerCharacters: ["$"],
				getSuggestions: async () => ({ items: [{ value: "$skill-name", label: "skill-name" }], prefix: "$" }),
				applyCompletion,
			});
			editor.setAutocompleteProvider({
				getSuggestions: async () => {
					suggestionCalls += 1;
					return { items: [{ value: "$skill-name", label: "skill-name" }], prefix: "$" };
				},
				applyCompletion,
			});

			editor.handleInput("$");
			editor.handleInput("s");
			await new Promise((resolve) => setTimeout(resolve, 50));
			await flushAutocomplete();

			assert.strictEqual(suggestionCalls, 0);
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("aborts active @ autocomplete when typing continues", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let aborts = 0;

			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (_lines, _cursorLine, _cursorCol, options) => {
					return await new Promise((resolve) => {
						const timeout = setTimeout(() => {
							resolve({ items: [{ value: "@main.ts", label: "main.ts" }], prefix: "@main" });
						}, 500);
						options.signal.addEventListener(
							"abort",
							() => {
								aborts += 1;
								clearTimeout(timeout);
								resolve(null);
							},
							{ once: true },
						);
					});
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			editor.handleInput("@");
			editor.handleInput("m");
			editor.handleInput("a");
			editor.handleInput("i");
			await new Promise((resolve) => setTimeout(resolve, 250));
			editor.handleInput("n");
			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.strictEqual(aborts, 1);
		});

		it("hides autocomplete when backspacing slash command to empty", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 创建包含斜杠命令的模拟提供器。
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const prefix = text.slice(0, cursorCol);
					// 仅当行首为 / 时返回斜杠命令建议。
					if (prefix.startsWith("/")) {
						const commands = [
							{ value: "/model", label: "model", description: "Change model" },
							{ value: "/help", label: "help", description: "Show help" },
						];
						const query = prefix.slice(1); // 移除开头的 /。
						const filtered = commands.filter((c) => c.value.startsWith(query));
						if (filtered.length > 0) {
							return { items: filtered, prefix };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 "/" 后应显示斜杠命令建议。
			editor.handleInput("/");
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "/");
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 按退格键删除 "/" 后应完全隐藏自动补全。
			editor.handleInput("\x7f"); // Backspace
			await flushAutocomplete();
			assert.strictEqual(editor.getText(), "");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("applies exact typed slash-argument value on Enter even when first item is highlighted", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 为 /argtest 命令及其参数补全创建模拟提供器。
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					// 检查当前是否处于参数补全上下文："/argtest <prefix>"。
					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "one", label: "one" },
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
						];
						// 返回所有以已输入前缀开头的参数。
						const filtered = allArguments.filter((arg) => arg.value.startsWith(argumentText));
						if (filtered.length > 0) {
							return { items: filtered, prefix: argumentText };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 "/argtest two"。
			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");
			editor.handleInput("w");
			editor.handleInput("o");

			assert.strictEqual(editor.getText(), "/argtest two");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 按 Enter 应应用实际输入的值 "two"，而不是列表中的第一项。
			editor.handleInput("\r");

			// 应保留实际输入的值 "two"。
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		it("selects first prefix match on Enter when typed arg is not exact match", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 为 /argtest 命令及其参数补全创建模拟提供器。
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					// 检查当前是否处于参数补全上下文。
					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
							{ value: "twelve", label: "twelve" },
						];
						// 返回所有以已输入前缀开头的项目。
						const filtered = allArguments.filter((arg) => arg.value.startsWith(argumentText));
						if (filtered.length > 0) {
							return { items: filtered, prefix: argumentText };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 "/argtest t" 后筛选为 [two, three, twelve]；前缀 "t" 首先匹配 "two"。
			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");

			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 按 Enter 后，前缀 "t" 首先匹配列表中的 "two"，因此应用 "two"。
			editor.handleInput("\r");
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		it("highlights unique prefix match as user types (before full exact match)", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 创建不筛选项目的模拟提供器（与真实扩展的行为一致）。
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						// 返回所有项目，由调用方负责筛选。
						const allArguments = [
							{ value: "one", label: "one" },
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
						];
						return { items: allArguments, prefix: argumentText };
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 "/argtest tw"；"tw" 仅是 "two" 的前缀。
			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");
			editor.handleInput("w");

			assert.strictEqual(editor.getText(), "/argtest tw");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 按 Enter 后，"tw" 唯一匹配 "two"，因此应应用 "two"。
			editor.handleInput("\r");
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		it("selects first prefix match when multiple items match", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 创建返回全部项目、不进行筛选的模拟提供器。
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					const argtestMatch = beforeCursor.match(/^\/argtest\s+(\S+)$/);
					if (argtestMatch) {
						const argumentText = argtestMatch[1]!;
						const allArguments = [
							{ value: "one", label: "one" },
							{ value: "two", label: "two" },
							{ value: "three", label: "three" },
						];
						return { items: allArguments, prefix: argumentText };
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 "/argtest t"；"t" 同时是 "two" 和 "three" 的前缀。
			editor.handleInput("/");
			editor.handleInput("a");
			editor.handleInput("r");
			editor.handleInput("g");
			editor.handleInput("t");
			editor.handleInput("e");
			editor.handleInput("s");
			editor.handleInput("t");
			editor.handleInput(" ");
			editor.handleInput("t");

			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 按 Enter 后，"t" 首先匹配 "two"，因此选择 "two"。
			editor.handleInput("\r");
			assert.strictEqual(editor.getText(), "/argtest two");
		});

		it("works for built-in-style command argument completion path (model-like)", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 为 /model 命令的模型补全创建模拟提供器。
			const mockProvider: AutocompleteProvider = {
				getSuggestions: async (lines, _cursorLine, cursorCol) => {
					const text = lines[0] || "";
					const beforeCursor = text.slice(0, cursorCol);

					// 检查当前是否处于 /model 参数补全上下文。
					// 使用 [^ ]+ 匹配所有非空格字符（包括连字符）。
					const modelMatch = beforeCursor.match(/^\/model\s+(\S+)$/);
					if (modelMatch) {
						const modelText = modelMatch[1]!;
						const allModels = [
							{ value: "gpt-4o", label: "gpt-4o" },
							{ value: "gpt-4o-mini", label: "gpt-4o-mini" },
							{ value: "claude-sonnet", label: "claude-sonnet" },
						];
						// 返回所有以已输入前缀开头的模型。
						const filtered = allModels.filter((m) => m.value.startsWith(modelText));
						if (filtered.length > 0) {
							return { items: filtered, prefix: modelText };
						}
					}
					return null;
				},
				applyCompletion,
			};

			editor.setAutocompleteProvider(mockProvider);

			// 输入 "/model gpt-4o-mini"，与列表中的第二项完全匹配。
			editor.handleInput("/");
			editor.handleInput("m");
			editor.handleInput("o");
			editor.handleInput("d");
			editor.handleInput("e");
			editor.handleInput("l");
			editor.handleInput(" ");
			editor.handleInput("g");
			editor.handleInput("p");
			editor.handleInput("t");
			editor.handleInput("-");
			editor.handleInput("4");
			editor.handleInput("o");
			editor.handleInput("-");
			editor.handleInput("m");
			editor.handleInput("i");
			editor.handleInput("n");
			editor.handleInput("i");

			assert.strictEqual(editor.getText(), "/model gpt-4o-mini");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			// 按 Enter 应保留实际输入的值，而不是应用高亮的第一项。
			editor.handleInput("\r");

			// 应保留实际输入的值。
			assert.strictEqual(editor.getText(), "/model gpt-4o-mini");
		});

		it("awaits async slash command argument completions", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[
					{
						name: "load-skills",
						description: "Load skills",
						getArgumentCompletions: async (prefix) =>
							prefix.startsWith("s") ? [{ value: "skill-a", label: "skill-a" }] : null,
					},
				],
				process.cwd(),
			);
			editor.setAutocompleteProvider(provider);
			editor.setText("/load-skills ");

			editor.handleInput("s");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), "/load-skills skill-a");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});

		it("ignores invalid slash command argument completion results", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[
					{
						name: "load-skills",
						description: "Load skills",
						getArgumentCompletions: (() => "not-an-array") as unknown as (
							argumentPrefix: string,
						) => Promise<{ value: string; label: string }[] | null>,
					},
				],
				process.cwd(),
			);
			editor.setAutocompleteProvider(provider);
			editor.setText("/load-skills ");

			editor.handleInput("s");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), false);
			assert.strictEqual(editor.getText(), "/load-skills s");
		});

		it("does not show argument completions when command has no argument completer", async () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const provider = new CombinedAutocompleteProvider(
				[
					{ name: "help", description: "Show help" },
					{
						name: "model",
						description: "Switch model",
						getArgumentCompletions: () => [{ value: "claude-opus", label: "claude-opus" }],
					},
				],
				process.cwd(),
			);
			editor.setAutocompleteProvider(provider);

			editor.handleInput("/");
			editor.handleInput("h");
			editor.handleInput("e");
			await flushAutocomplete();
			assert.strictEqual(editor.isShowingAutocomplete(), true);

			editor.handleInput("\t");
			assert.strictEqual(editor.getText(), "/help ");
			assert.strictEqual(editor.isShowingAutocomplete(), false);
		});
	});

	describe("Character jump (Ctrl+])", () => {
		it("jumps forward to first occurrence of character on same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]（Ctrl+] 的旧版按键序列）。
			editor.handleInput("o"); // 跳转到first 'o'。

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 }); // 'o' in "hello"
		});

		it("jumps forward to next occurrence after cursor", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			// 将光标移到 "hello" 中的 'o' 处（第 4 列）。
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("o"); // 跳转到next 'o' (in "world")。

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 'o' in "world"
		});

		it("jumps forward across multiple lines", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("abc\ndef\nghi");
			// 光标位于末尾（第 2 行，第 3 列）。按向上键移至第 0 行，再按 Ctrl+A。
			editor.handleInput("\x1b[A"); // 按向上键。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行。
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("g"); // 跳转到第 3 行中的“g”。

			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });
		});

		it("jumps backward to first occurrence before cursor on same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			// 光标位于末尾（第 11 列）。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]（先发送 ESC，再发送 Ctrl+]）。
			editor.handleInput("o"); // 跳转到光标前最后一个“o”。

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 }); // 'o' in "world"
		});

		it("jumps backward across multiple lines", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("abc\ndef\nghi");
			// 光标位于第 3 行末尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 3 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
			editor.handleInput("a"); // 跳转到第 1 行的“a”。

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		it("does nothing when character is not found (forward)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("z"); // 'z' doesn't exist

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // Cursor unchanged
		});

		it("does nothing when character is not found (backward)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			// 光标位于末尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
			editor.handleInput("z"); // 'z' doesn't exist

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 }); // Cursor unchanged
		});

		it("is case-sensitive", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("Hello World");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 搜索小写字母 'h'：应找不到，因为文本中只有大写 'H'。
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("h");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // Cursor unchanged

			// 搜索大写字母 'W'：应能找到。
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("W");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 }); // 'W' in "World"
		});

		it("cancels jump mode when Ctrl+] is pressed again", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+] - enter jump mode
			editor.handleInput("\x1d"); // Ctrl+] again - cancel

			// 正常输入 'o'：应插入字符，而非跳转。
			editor.handleInput("o");
			assert.strictEqual(editor.getText(), "ohello world");
		});

		it("cancels jump mode on Escape and processes the Escape", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+] - enter jump mode
			editor.handleInput("\x1b"); // 按 Escape 取消跳转模式。

			// 光标应保持不变（Escape 本身不会在编辑器中移动光标）。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 正常输入 'o'：应插入字符，而非跳转。
			editor.handleInput("o");
			assert.strictEqual(editor.getText(), "ohello world");
		});

		it("cancels backward jump mode when Ctrl+Alt+] is pressed again", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			// 光标位于末尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] - enter backward jump mode
			editor.handleInput("\x1b\x1d"); // Ctrl+Alt+] again - cancel

			// 正常输入 'o'：应插入字符，而非跳转。
			editor.handleInput("o");
			assert.strictEqual(editor.getText(), "hello worldo");
		});

		it("searches for special characters", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("foo(bar) = baz;");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 跳转到 '('。
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("(");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			// 跳转到 '='。
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("=");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });
		});

		it("handles empty text gracefully", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("x");

			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 }); // Cursor unchanged
		});

		it("resets lastAction when jumping", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world");
			editor.handleInput("\x01"); // Ctrl+A：移至行首。

			// 输入字符，将 lastAction 设为 "type-word"。
			editor.handleInput("x");
			assert.strictEqual(editor.getText(), "xhello world");

			// 向前跳转。
			editor.handleInput("\x1d"); // Ctrl+]
			editor.handleInput("o");

			// 继续输入：应开始新的撤销单元（lastAction 已重置）。
			editor.handleInput("Y");
			assert.strictEqual(editor.getText(), "xhellYo world");

			// 撤销操作只应撤销 "Y"，不能同时撤销 "x"。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "xhello world");
		});
	});

	describe("Sticky column", () => {
		// 辅助函数：将光标定位到指定行和列。
		function positionCursor(editor: Editor, line: number, col: number): void {
			// 先移至第 0 行。
			for (let i = 0; i < 20; i++) editor.handleInput("\x1b[A");
			// 移至目标行。
			for (let i = 0; i < line; i++) editor.handleInput("\x1b[B");
			// 移至目标列。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < col; i++) editor.handleInput("\x1b[C");
		}

		it("preserves target column when moving up through a shorter line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 第 0 行："2222222222x222"（x 位于第 10 列）。
			// 第 1 行：""（空行）。
			// 第 2 行："1111111111_111111111111"（_ 位于第 10 列）。
			editor.setText("2222222222x222\n\n1111111111_111111111111");

			// 将光标定位到 _ 处（第 2 行，第 10 列）。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 23 }); // 位于末尾。
			editor.handleInput("\x01"); // Ctrl+A：移至行首。 of line
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C"); // 向右移动至第 10 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 });

			// 按向上键应移至空行（列位置限制为 0）。
			editor.handleInput("\x1b[A"); // 按向上键。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// 再按向上键应移至第 0 行第 10 列（即 'x' 处）。
			editor.handleInput("\x1b[A"); // 按向上键。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
		});

		it("preserves target column when moving down through a shorter line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1111111111_111\n\n2222222222x222222222222");

			// 将光标定位到 _ 处（第 0 行，第 10 列）。
			editor.handleInput("\x1b[A"); // 按向上键移至第 1 行。
			editor.handleInput("\x1b[A"); // 按向上键移至第 0 行。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			// 按向下键应移至空行（列位置限制为 0）。
			editor.handleInput("\x1b[B"); // 按向下键。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// 再按向下键应移至第 2 行第 10 列（即 'x' 处）。
			editor.handleInput("\x1b[B"); // 按向下键。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 });
		});

		it("resets sticky column on horizontal movement (left arrow)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// 从第 2 行第 5 列开始。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });

			// 向上经过空行。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 5 列 (sticky)。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			// 向左移动会重置固定列。
			editor.handleInput("\x1b[D"); // Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });

			// 向下移动两次。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行、第 4 列，固定列更新为 4。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 4 });
		});

		it("resets sticky column on horizontal movement (right arrow)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// 从第 0 行第 5 列开始。
			editor.handleInput("\x1b[A"); // 按向上键移至第 1 行。
			editor.handleInput("\x1b[A"); // 按向上键移至第 0 行。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			// 向下经过空行。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行、第 5 列 (sticky)。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });

			// 向右移动会重置固定列。
			editor.handleInput("\x1b[C"); // Right
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });

			// 向上移动两次。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 6 列，固定列更新为 6。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		});

		it("resets sticky column on typing", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// 从第 2 行第 8 列开始。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// 向上经过空行。
			editor.handleInput("\x1b[A"); // 按向上键。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 8 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			// 输入字符会重置固定列。
			editor.handleInput("X");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });

			// 向下移动两次。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行、第 9 列，固定列更新为 9。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 9 });
		});

		it("resets sticky column on backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// 从第 2 行第 8 列开始。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// 向上经过空行。
			editor.handleInput("\x1b[A"); // 按向上键。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 8 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			// 按退格键会重置固定列。
			editor.handleInput("\x7f"); // Backspace
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });

			// 向下移动两次。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行、第 7 列，固定列更新为 7。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 7 });
		});

		it("resets sticky column on Ctrl+A (move to line start)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// 从第 2 行第 8 列开始。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");

			// 向上移动，记录固定列 8。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 0 列。

			// Ctrl+A 会将固定列重置为 0。
			editor.handleInput("\x01"); // Ctrl+A
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// 向上移动。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 0 列，固定列更新为 0。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		it("resets sticky column on Ctrl+E (move to line end)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("12345\n\n1234567890");

			// 从第 2 行第 3 列开始。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");

			// 向上经过空行，并记录固定列 3。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 3 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			// Ctrl+E 会将固定列重置到行末。
			editor.handleInput("\x05"); // Ctrl+E
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			// 向下移动两次。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行、第 5 列，固定列更新为 5。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });
		});

		it("resets sticky column on word movement (Ctrl+Left)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world\n\nhello world");

			// 从第 2 行末尾开始（第 11 列）。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 11 });

			// 向上经过空行，并记录固定列 11。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 11 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 11 });

			// Ctrl+Left 按词移动时会重置固定列。
			editor.handleInput("\x1b[1;5D"); // Ctrl+Left
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 }); // 位于 world 之前。

			// 向下移动两次。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行、第 6 列，固定列更新为 6。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });
		});

		it("resets sticky column on word movement (Ctrl+Right)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("hello world\n\nhello world");

			// 从第 0 行第 0 列开始。
			editor.handleInput("\x1b[A"); // 按向上键。
			editor.handleInput("\x1b[A"); // 按向上键。
			editor.handleInput("\x01"); // Ctrl+A
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 向下经过空行，并记录固定列 0。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行、第 0 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });

			// Ctrl+Right 按词移动时会重置固定列。
			editor.handleInput("\x1b[1;5C"); // Ctrl+Right
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 }); // 位于 hello 之后。

			// 向上移动两次。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 5 列，固定列更新为 5。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		});

		it("resets sticky column on undo", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// 移至第 0 行第 8 列。
			editor.handleInput("\x1b[A"); // 按向上键移至第 1 行。
			editor.handleInput("\x1b[A"); // 按向上键移至第 0 行。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			// 向下经过空行，并记录固定列 8。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行、第 8 列 (sticky)。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 8 });

			// 输入内容以创建可撤销状态；这会清除固定列并将列位置设为 9。
			editor.handleInput("X");
			assert.strictEqual(editor.getText(), "1234567890\n\n12345678X90");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 9 });

			// 向上移动，记录新的固定列 9。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 9 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 9 });

			// 撤销会重置固定列，并将光标恢复到第 2 行第 8 列。
			editor.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(editor.getText(), "1234567890\n\n1234567890");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 8 });

			// 向上移动时应根据恢复后的第 8 列记录新的固定列，而不是沿用旧值 9。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 8 列，固定列根据恢复的位置重新确定。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });
		});

		it("handles multiple consecutive up/down movements", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\nab\ncd\nef\n1234567890");

			// 从第 4 行第 7 列开始。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 7; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 7 });

			// 多次向上经过较短的行。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 3 行、第 2 列 (clamped)。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 2 行、第 2 列 (clamped)。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 2 列 (clamped)。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 7 列 (restored)。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 7 });

			// 多次向下移动，固定列仍应为 7。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行、第 2 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行、第 2 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 3 行、第 2 列。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 4 行、第 7 列 (restored)。
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 7 });
		});

		it("moves correctly through wrapped visual lines without getting stuck", () => {
			const tui = createTestTUI(15, 24); // Narrow terminal
			const editor = new Editor(tui, defaultEditorTheme);

			// 第 0 行：短文本。
			// 第 1 行：30 个字符；宽度为 10（扣除填充后）时会换成 3 个显示行。
			editor.setText("short\n123456789012345678901234567890");
			editor.render(15); // 此时布局宽度为 14 列。

			// 将光标放在第 1 行末尾（第 30 列）。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 30 });

			// 连续向上移动时应逐个经过文本换行后的显示行，
			// 最终到达第 0 行。
			editor.handleInput("\x1b[A"); // 按向上键移至第 1 行内的上一个显示行。
			assert.strictEqual(editor.getCursor().line, 1);

			editor.handleInput("\x1b[A"); // 按向上键再移至上一个显示行。
			assert.strictEqual(editor.getCursor().line, 1);

			editor.handleInput("\x1b[A"); // 按向上键应到达第 0 行。
			assert.strictEqual(editor.getCursor().line, 0);
		});

		it("handles setText resetting sticky column", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			editor.setText("1234567890\n\n1234567890");

			// 记录固定列。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 8; i++) editor.handleInput("\x1b[C");
			editor.handleInput("\x1b[A"); // 按向上键。

			// setText 应重置固定列。
			editor.setText("abcdefghij\n\nabcdefghij");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 }); // 位于末尾。

			// 向上移动时应根据当前位置（第 10 列）记录新的固定列。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 1 行、第 0 列。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 10 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
		});

		it("sets preferredVisualCol when pressing right at end of prompt (last line)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 第 0 行：20 个字符，'x' 位于第 10 列。
			// 第 1 行：空行。
			// 第 2 行：10 个字符，以 '_' 结尾。
			editor.setText("111111111x1111111111\n\n333333333_");

			// 移至第 0 行，按 Ctrl+E 到行末（第 20 列）。
			editor.handleInput("\x1b[A"); // 按向上键移至第 1 行。
			editor.handleInput("\x1b[A"); // 按向上键移至第 0 行。
			editor.handleInput("\x05"); // Ctrl+E：将光标移至行尾。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 20 });

			// 向下移至第 2 行，光标限制在第 10 列（行末）。
			editor.handleInput("\x1b[B"); // 按向下键移至第 1 行、第 0 列。
			editor.handleInput("\x1b[B"); // 按向下键移至第 2 行、第 10 列 (clamped)。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 });

			// 在提示符末尾按向右键：位置看似未变，但会将 preferredVisualCol 设为 10。
			editor.handleInput("\x1b[C"); // 无法继续向右移动，但会设置 preferredVisualCol。
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 10 }); // 仍位于原位置。

			// 向上移动两次到第 0 行，应使用 preferredVisualCol（10）定位到 'x'。
			editor.handleInput("\x1b[A"); // 按向上键移至第 1 行、第 0 列。
			editor.handleInput("\x1b[A"); // 按向上键移至第 0 行、第 10 列。 (on 'x')
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });
		});

		it("handles editor resizes when preferredVisualCol is on the same line", () => {
			// 在更宽的终端中创建编辑器。
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			editor.setText("12345678901234567890\n\n12345678901234567890");

			// 从第 2 行第 15 列开始。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");

			// 向上经过空行，并记录固定列 15。
			editor.handleInput("\x1b[A"); // 按向上键。
			editor.handleInput("\x1b[A"); // 按向上键后位于第 0 行、第 15 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 15 });

			// 使用较窄的宽度进行渲染，以模拟终端尺寸变化。
			editor.render(12); // Width 12

			// 向下移动时，固定列应限制在新的宽度范围内。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 1 行。
			editor.handleInput("\x1b[B"); // 按向下键后位于第 2 行，列位置应限制在有效范围内。
			assert.equal(editor.getCursor().col, 4);
		});

		it("handles editor resizes when preferredVisualCol is on a different line", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			// 创建一行会在宽度为 10 时换成多个显示行的文本。
			// "12345678901234567890" 共 20 个字符，在宽度为 10 时会折成 2 个显示行。
			editor.setText("short\n12345678901234567890");

			// 移至第 1 行第 15 列。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 15; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 15 });

			// 向上移动，以记录固定列 15。
			editor.handleInput("\x1b[A"); // 按向上键移至第 0 行。
			// 第 0 行只有 5 个字符，因此光标位于第 5 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });

			// 缩窄编辑器。
			editor.render(10);

			// 向下移动：preferredVisualCol 为 15，但宽度为 10。
			// 光标应落在第 1 行，并限制在宽度范围内（显示列 9，也就是逻辑列 9）。
			editor.handleInput("\x1b[B"); // 按向下键移至第 1 行。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });

			// 向上移动。
			editor.handleInput("\x1b[A"); // 向上移动到第 0 行。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 }); // 第 0 行只有 5 个字符。

			// 恢复原来的宽度。
			editor.render(80);

			// 向下移动；preferredVisualCol 保留为 15。
			editor.handleInput("\x1b[B"); // 按向下键移至第 1 行。
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 15 });
		});

		it("rewrapped lines: target fits current visual column", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("abcdefghijklmnopqr\n123456789012345678");

			positionCursor(editor, 0, 18);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 18 });

			// 将宽度缩至 10（layoutWidth = 9）。
			// 第 0 行最后一个片段的最大显示列为 9，第 1 行第一个片段的最大显示列为 8。
			editor.render(10);

			// 向下移动时，光标限制在第 8 列。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });

			// 恢复较宽尺寸后向上移动，此时以当前显示列为准。
			editor.render(80);
			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 8 });

			// 重新换行的分支已清除 preferred 列。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });
		});

		it("rewrapped lines: target shorter than current visual column", () => {
			const tui = createTestTUI(80, 24);
			const editor = new Editor(tui, defaultEditorTheme);
			editor.setText("abcdefghijklmnopqr\n123456789012345678\nab");

			positionCursor(editor, 0, 18);
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 18 });

			// 将宽度缩至 10（layoutWidth = 9），向下移动时限制在第 8 列。
			editor.render(10);
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });

			// 加宽编辑器。
			editor.render(80);

			// 向下移至较短的行 "ab"。
			// preferredVisualCol 更新为当前显示列 8，光标限制在第 2 列。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 2 });

			// 向上移动会恢复到固定列 8。
			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 8 });
		});
	});

	describe("Paste marker atomic behavior", () => {
		/** 辅助函数：模拟会生成标记的大段粘贴内容。 */
		function pasteWithMarker(editor: Editor): string {
			const bigContent = "line\n".repeat(20).trimEnd(); // 共 20 行。
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			// 编辑器会用类似 "[paste #1 +20 lines]" 的标记替换大段粘贴内容。
			return editor.getText();
		}

		/** 辅助函数：生成带有区分标记的 12 行粘贴内容。 */
		function bigPaste(tag: string): string {
			return Array.from({ length: 12 }, (_, i) => `${tag}${i}`).join("\n");
		}

		it("creates a paste marker for large pastes", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const text = pasteWithMarker(editor);
			assert.match(text, /\[paste #\d+ \+\d+ lines\]/);
		});

		it("treats paste marker as single unit for right arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");
			// 文本为 "A[paste #1 +20 lines]B"，光标位于末尾。

			// 移至开头。
			editor.handleInput("\x01"); // Ctrl+A
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

			// 按向右键应移过 "A"。
			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

			// 按向右键应跳过整个标记。
			editor.handleInput("\x1b[C");
			const marker = editor.getText().match(/\[paste #\d+ \+\d+ lines\]/)![0];
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length });

			// 按向右键应移过 "B"。
			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length + 1 });
		});

		it("treats paste marker as single unit for left arrow", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");
			// 光标位于末尾。

			// 按向左键，移过 "B"。
			editor.handleInput("\x1b[D");
			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length });

			// 按向左键，跳过整个标记。
			editor.handleInput("\x1b[D");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

			// 按向左键，移过 "A"。
			editor.handleInput("\x1b[D");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
		});

		it("treats paste marker as single unit for backspace", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];

			// 将光标放在标记之后（"B" 之前）。
			editor.handleInput("\x01"); // Ctrl+A
			// 移过 "A" 和标记。
			editor.handleInput("\x1b[C"); // 移过“A”。
			editor.handleInput("\x1b[C"); // 移过标记。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 + marker.length });

			// 按退格键应一次删除整个标记。
			editor.handleInput("\x7f");
			assert.strictEqual(editor.getText(), "AB");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		});

		it("treats paste marker as single unit for forward delete", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			// 将光标放在 "A" 处（第 0 列），再向右移动一次到标记前。
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // 越过“A”后位于第 1 列，即标记开头。

			// 按向前删除键应一次删除整个标记。
			editor.handleInput("\x1b[3~"); // Delete 键。
			assert.strictEqual(editor.getText(), "AB");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });
		});

		it("treats paste marker as single unit for word movement", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("X");
			editor.handleInput(" ");
			pasteWithMarker(editor);
			editor.handleInput(" ");
			editor.handleInput("Y");
			// 文本为 "X [paste #1 +20 lines] Y"。

			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/)![0];

			// 移至开头。
			editor.handleInput("\x01"); // Ctrl+A

			// Ctrl+Right：跳过 "X"。
			editor.handleInput("\x1b[1;5C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

			// Ctrl+Right：跳过空白和标记（标记作为一个整体处理，既不是空白也不是标点）。
			editor.handleInput("\x1b[1;5C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 2 + marker.length });
		});

		it("undo restores marker after backspace deletion", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			editor.handleInput("A");
			pasteWithMarker(editor);
			editor.handleInput("B");

			const textBefore = editor.getText();

			// 将光标放在标记之后。
			editor.handleInput("\x01");
			editor.handleInput("\x1b[C"); // 移过 A。
			editor.handleInput("\x1b[C"); // 移过标记。

			// 删除标记。
			editor.handleInput("\x7f");
			assert.strictEqual(editor.getText(), "AB");

			// 撤销。
			editor.handleInput("\x1b[45;5u");
			assert.strictEqual(editor.getText(), textBefore);
		});

		it("undo after paste marker deletion restores the paste registry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (t) => {
				submitted = t;
			};

			const paste = bigPaste("alpha");
			editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
			editor.handleInput("\x7f"); // 删除标记。
			editor.handleInput("\x1b[45;5u"); // 撤销：恢复标记文本和注册表。
			editor.handleInput("\r");
			assert.strictEqual(submitted, paste);
		});

		it("undo after deleting the first of two paste markers restores both registry entries", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (t) => {
				submitted = t;
			};

			const pasteA = bigPaste("alpha");
			const pasteB = bigPaste("beta");
			editor.handleInput(`\x1b[200~${pasteA}\x1b[201~`); // #1 = A
			editor.handleInput(`\x1b[200~${pasteB}\x1b[201~`); // 第二个标记对应 B，光标位于末尾。
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // 向右越过标记 #1。
			editor.handleInput("\x7f"); // 删除标记 #1，并将 #2 重新编号为 #1。
			editor.handleInput("\x1b[45;5u"); // 撤销。
			editor.handleInput("\r");
			assert.strictEqual(submitted, pasteA + pasteB);
		});

		it("renumbers the paste registry in ascending id order when markers are out of order in text", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (t) => {
				submitted = t;
			};

			const pasteA = bigPaste("alpha");
			const pasteB = bigPaste("beta");
			const pasteC = bigPaste("gamma");
			editor.handleInput(`\x1b[200~${pasteA}\x1b[201~`); // #1 = A
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput(`\x1b[200~${pasteB}\x1b[201~`); // #2 = B, text: [#2][#1]
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput(`\x1b[200~${pasteC}\x1b[201~`); // #3 = C, text: [#3][#2][#1]
			editor.handleInput("\x05"); // Ctrl+E
			editor.handleInput("\x7f"); // 删除标记 #1，并将 #3 重新编号为 #2、#2 重新编号为 #1。
			editor.handleInput("\r");
			assert.strictEqual(submitted, pasteC + pasteB);
		});

		it("undo after setText restores paste markers and registry", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			let submitted = "";
			editor.onSubmit = (t) => {
				submitted = t;
			};

			const paste = bigPaste("alpha");
			editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
			editor.setText("replacement");
			editor.handleInput("\x1b[45;5u"); // 撤销。
			editor.handleInput("\r");
			assert.strictEqual(submitted, paste);
		});

		it("handles multiple paste markers in same line", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			pasteWithMarker(editor);
			editor.handleInput(" ");
			pasteWithMarker(editor);

			const text = editor.getText();
			const markers = [...text.matchAll(/\[paste #\d+ \+\d+ lines\]/g)];
			assert.strictEqual(markers.length, 2);

			// 移至开头。
			editor.handleInput("\x01");

			// 按向右键应将第一个标记作为整体跳过。
			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markers[0]![0].length });

			// 按向右键移过空格。
			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markers[0]![0].length + 1 });

			// 按向右键应将第二个标记作为整体跳过。
			editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), {
				line: 0,
				col: markers[0]![0].length + 1 + markers[1]![0].length,
			});
		});

		it("does not treat manually typed marker-like text as atomic (no valid paste ID)", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			// 手动输入符合标记格式的文本，但没有对应的粘贴记录。
			const fakeMarker = "[paste #99 +5 lines]";
			for (const ch of fakeMarker) editor.handleInput(ch);

			assert.strictEqual(editor.getText(), fakeMarker);

			// 不存在 ID 为 99 的粘贴记录，因此不会将该标记视为原子片段。
			// 按向右键时应一次移动一个字素簇。
			editor.handleInput("\x01"); // Ctrl+A
			editor.handleInput("\x1b[C"); // Right
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 }); // 光标刚好位于 "[" 之后。
		});

		it("does not crash when paste marker is wider than terminal width", () => {
			// 复现条件：终端宽度为 8，粘贴标记 "[paste #1 +47 lines]" 长 21 个字符。
			const tui = createTestTUI();
			const editor = new Editor(tui, defaultEditorTheme);
			const bigContent = "line\n".repeat(47).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			const text = editor.getText();
			const marker = text.match(/\[paste #\d+ \+\d+ lines\]/);
			assert.ok(marker, "paste marker should be created");
			assert.ok(visibleWidth(marker[0]) > 8, "marker should be wider than render width");

			// 在很窄的宽度下渲染，不应抛出异常。
			const lines = editor.render(8);
			// 每个渲染行都必须适配指定宽度（标记会被拆分）。
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= 8,
					`line exceeds width 8: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
				);
			}
		});

		it("does not crash when text + paste marker exceeds terminal width with cursor on marker", () => {
			// 复现条件：终端宽度为 54，文本为 "b".repeat(35) + "[paste #1 +27 lines]" + "bbbb"。
			// 单词换行后光标落在粘贴标记上，导致渲染行的可见宽度达到 55，超过终端宽度 1 列。
			const tui = createTestTUI();
			const editor = new Editor(tui, defaultEditorTheme);

			// 输入 35 个 'b' 字符。
			for (let i = 0; i < 35; i++) editor.handleInput("b");

			// 粘贴 27 行内容。
			const bigContent = "line\n".repeat(27).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			// 再输入几个字符。
			for (let i = 0; i < 4; i++) editor.handleInput("b");

			// 向左移动光标，使其落在粘贴标记上。
			editor.handleInput("\x1b[D"); // 移至最后一个 b 之前。
			editor.handleInput("\x1b[D"); // 移至最后一个 b 之前。
			editor.handleInput("\x1b[D"); // 移至最后一个 b 之前。
			editor.handleInput("\x1b[D"); // 移至最后一个 b 之前。
			editor.handleInput("\x1b[D"); // 此时光标位于粘贴标记上。

			// 按宽度 54 渲染，不应抛出异常。
			const renderWidth = 54;
			const lines = editor.render(renderWidth);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= renderWidth,
					`line exceeds width ${renderWidth}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
				);
			}
		});

		it("wordWrapLine re-checks overflow after backtracking to wrap opportunity", () => {
			// 复现崩溃 #2：" " + "b".repeat(35) + atomic_marker（20 个字符）+ "bbbb"。
			// layoutWidth=53。在空格处换行后，剩余的 35 个 b 和标记共占 55 列，
			// 必须再次强制换行，不能无声溢出。
			const tui = createTestTUI();
			const editor = new Editor(tui, defaultEditorTheme);

			// 输入一个空格，再输入 35 个 b。
			editor.handleInput(" ");
			for (let i = 0; i < 35; i++) editor.handleInput("b");

			// 粘贴 27 行内容以生成标记。
			const bigContent = "line\n".repeat(27).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);

			// 输入末尾字符。
			for (let i = 0; i < 4; i++) editor.handleInput("b");

			// 按宽度 54 渲染（paddingX=0 时，contentWidth=54，layoutWidth=53）。
			const renderWidth = 54;
			const lines = editor.render(renderWidth);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= renderWidth,
					`line exceeds width ${renderWidth}: visible=${visibleWidth(line)} text=${JSON.stringify(line)}`,
				);
			}
		});

		it("expands large pasted content literally in getExpandedText", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const pastedText = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"line 8",
				"line 9",
				"line 10",
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);

			assert.match(editor.getText(), /\[paste #\d+ \+\d+ lines\]/);
			assert.strictEqual(editor.getExpandedText(), pastedText);
		});

		it("snaps to the paste marker start when navigating down into it", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);

			// 第 0 行文本足够长，可用于记录固定列。
			editor.setText("12345678901234567890\n\nhello ");

			// 粘贴大段内容以生成标记。
			const bigContent = "x".repeat(2000);
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			editor.render(80);

			const text = editor.getText();
			const _marker = text.match(/\[paste #\d+ \d+ chars\]/)![0];
			// 第 0 行："12345678901234567890"。
			// 第 1 行：""（空行）。
			// 第 2 行："hello [paste #1 2000 chars]"。
			//         标记从第 6 列开始。

			// 导航到第 0 行第 10 列。
			editor.handleInput("\x1b[A"); // 按向上键移至第 1 行。
			editor.handleInput("\x1b[A"); // 按向上键移至第 0 行。
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C"); // Right 10
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			// 向下移至空行。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// 向下移至粘贴标记所在行时，固定列 10 落在标记内部（标记从第 6 列开始）。
			// 光标应吸附到标记开头（第 6 列），而非标记末尾（第 6 列 + marker.length）。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 6 });
		});

		it("preserves sticky column when navigating through paste marker line", () => {
			const tui = createTestTUI(30, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			// 构造以下文本：
			// 第 0 行："1234567890123456"（16 个字符）。
			// 第 1 行：""（空行）。
			// 第 2 行："[paste #1 2000 chars]"（22 个字符的粘贴标记）。
			// 第 3 行：""（空行）。
			// 第 4 行："abcdefghijklmnop"（16 个字符）。
			for (const ch of "1234567890123456") editor.handleInput(ch);
			editor.handleInput("\n");
			editor.handleInput("\n");
			editor.handleInput(`\x1b[200~${"x".repeat(2000)}\x1b[201~`);
			editor.handleInput("\n");
			editor.handleInput("\n");
			for (const ch of "abcdefghijklmnop") editor.handleInput(ch);
			editor.render(30);

			// 导航到第 0 行第 10 列。
			for (let i = 0; i < 4; i++) editor.handleInput("\x1b[A"); // 按向上键移至第 0 行。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 10; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

			// 向下移至空行，固定列记录为 10。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });

			// 向下移至粘贴标记时，光标吸附到第 0 列（标记开头）。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 0 });

			// 向下移至空行。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 3, col: 0 });

			// 向下移至最后一行，固定列应恢复为 10。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 4, col: 10 });
		});

		it("does not get stuck moving down from a multi-visual-line paste marker", () => {
			const tui = createTestTUI(20, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			// 构造以下文本：
			// 逻辑行 0："abcdefgh" + 标记（21 个字符）+ "ijklmnopqr"。
			// 逻辑行 1："123456789012345678"。
			//
			// 标记 "[paste #1 +100 lines]" 长 21 个字符，超过终端宽度 20。
			// 单词换行会在 "lines" 前的空格处断开，结果如下：
			//   VL1: abcdefgh              (起始列 0，长度 8)
			//   VL2: [paste #1 +100        (startCol 8,  len 15) <- 标记前半部分
			//   VL3: lines]ijklmnopqr      (startCol 23, len 16) <- 标记后半部分和正文
			//   VL4: 123456789012345678    (逻辑行 1)
			//
			// 在 VL3 上，标记尾部 "lines]" 占据显示列 0–5。
			// 正文（"i"）从显示列 6 开始，对应逻辑列 29。
			for (const ch of "abcdefgh") editor.handleInput(ch);
			const bigContent = "line\n".repeat(100).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			for (const ch of "ijklmnopqr") editor.handleInput(ch);
			editor.handleInput("\n");
			for (const ch of "123456789012345678") editor.handleInput(ch);
			editor.render(20);

			const text = editor.getText();
			const markerMatch = text.match(/\[paste #\d+ \+\d+ lines]/);
			assert.ok(markerMatch, "paste marker should be created");
			const markerLen = markerMatch[0].length; // 21
			assert.ok(markerLen > 20, "marker should be wider than terminal");
			const markerStart = 8;
			const markerEnd = markerStart + markerLen; // 29

			// 导航到第 0 行第 6 列（"g" 处）。固定列 6 超过 VL3 上的标记尾部，
			// 因此光标应落在正文（第 29 列的 "i"）上，而不应吸附回标记。
			editor.handleInput("\x1b[A"); // 按向上键移至第 0 行。
			editor.handleInput("\x01"); // Ctrl+A：移至行首。
			for (let i = 0; i < 6; i++) editor.handleInput("\x1b[C"); // 向右移动至第 6 列。
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });

			// 向下移动：光标落在粘贴标记开头。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markerStart });

			// 再次向下移动：固定列 6 会落在 VL3 的第 29 列（"i"），即标记之后。
			// 光标仍停留在逻辑行 0。
			editor.handleInput("\x1b[B");
			assert.strictEqual(editor.getCursor().line, 0);
			assert.strictEqual(editor.getCursor().col, markerEnd); // 第 29 列对应字符“i”。

			// 向上移动：回到粘贴标记处。
			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: markerStart });

			// 再次向上移动：回到第 6 列（"g" 处）。
			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
		});

		it("skips marker continuation VLs when preferred col falls in marker tail", () => {
			const tui = createTestTUI(20, 24);
			const editor = new Editor(tui, defaultEditorTheme);

			// 布局相同。从第 3 列（"d"）开始。固定列 3 会映射到 VL3 的显示列 3，
			// 即标记尾部 "lines]" 内。moveToVisualLine 会识别这是续行并跳到 VL4
			//（逻辑行 1）。
			//   VL1: abcdefgh              (起始列 0，长度 8)
			//   VL2: [paste #1 +100        (起始列 8，长度 15) <- 标记头部
			//   VL3: lines]ijklmnopqr      (起始列 23，长度 16) <- 标记尾部与内容
			//   VL4: 123456789012345678    (第 1 行)
			for (const ch of "abcdefgh") editor.handleInput(ch);
			const bigContent = "line\n".repeat(100).trimEnd();
			editor.handleInput(`\x1b[200~${bigContent}\x1b[201~`);
			for (const ch of "ijklmnopqr") editor.handleInput(ch);
			editor.handleInput("\n");
			for (const ch of "123456789012345678") editor.handleInput(ch);
			editor.render(20);

			// 导航到第 0 行第 3 列（"d" 处）。
			editor.handleInput("\x1b[A"); // 按向上键移至第 0 行。
			editor.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 3; i++) editor.handleInput("\x1b[C");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

			// 向下移动：到达标记处。
			editor.handleInput("\x1b[B");
			assert.strictEqual(editor.getCursor().col, 8);

			// 向下移动：跳过 VL3（第 3 列位于标记尾部），落到逻辑行 1。
			editor.handleInput("\x1b[B");
			assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 3 });

			// 再向上返回。
			editor.handleInput("\x1b[A");
			assert.strictEqual(editor.getCursor().col, 8); // marker
			editor.handleInput("\x1b[A");
			assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
		});

		it("submits large pasted content literally", () => {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const pastedText = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"line 5",
				"line 6",
				"line 7",
				"line 8",
				"line 9",
				"line 10",
				"tokens $1 $2 $& $$ $` $' end",
			].join("\n");
			let submitted = "";
			editor.onSubmit = (text) => {
				submitted = text;
			};

			editor.handleInput(`\x1b[200~${pastedText}\x1b[201~`);
			editor.handleInput("\r");

			assert.strictEqual(submitted, pastedText);
		});
	});
});
