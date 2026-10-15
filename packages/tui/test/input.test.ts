import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

describe("Input component", () => {
	it("submits value including backslash on Enter", () => {
		const input = new Input();
		let submitted: string | undefined;

		input.onSubmit = (value) => {
			submitted = value;
		};

		// 依次输入 hello、反斜杠和 Enter。
		input.handleInput("h");
		input.handleInput("e");
		input.handleInput("l");
		input.handleInput("l");
		input.handleInput("o");
		input.handleInput("\\");
		input.handleInput("\r");

		// 输入框为单行，因此无需使用“反斜杠 + Enter”的换行方式。
		assert.strictEqual(submitted, "hello\\");
	});

	it("inserts backslash as regular character", () => {
		const input = new Input();

		input.handleInput("\\");
		input.handleInput("x");

		assert.strictEqual(input.getValue(), "\\x");
	});

	describe("render", () => {
		it("supports a custom prompt and styled placeholder", () => {
			const input = new Input({
				prompt: "",
				placeholder: "Find transcript",
				placeholderStyle: (text) => `\x1b[2m${text}\x1b[22m`,
			});
			input.focused = true;

			const [empty] = input.render(20);
			assert.ok(empty?.includes("\x1b[2m"));
			assert.strictEqual(stripTerminalSequences(empty ?? "").trimEnd(), "Find transcript");

			input.handleInput("n");
			const [populated] = input.render(20);
			assert.strictEqual(stripTerminalSequences(populated ?? "").trimEnd(), "n");
		});

		it("does not overflow with wide CJK and fullwidth text", () => {
			const width = 93;
			const cases = [
				"가나다라마바사아자차카타파하 한글 텍스트가 터미널 너비를 초과하면 크래시가 발생합니다 이것은 재현용 테스트입니다",
				"これはテスト文章です。日本語のテキストが正しく表示されるかどうかを確認するためのサンプルテキストです。あいうえお",
				"这是一段测试文本，用于验证中文字符在终端中的显示宽度是否被正确计算，如果不正确就会导致用户界面崩溃的问题",
				"ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ０１２３４５６７８９ａｂｃｄｅｆｇｈｉｊｋｌｍ",
			];
			const cursorPositions = [
				{ label: "start", move: (_input: Input) => {} },
				{
					label: "middle",
					move: (input: Input) => {
						for (let i = 0; i < 10; i++) input.handleInput("\x1b[C");
					},
				},
				{ label: "end", move: (input: Input) => input.handleInput("\x05") },
			];

			for (const text of cases) {
				for (const { label, move } of cursorPositions) {
					const input = new Input();
					input.setValue(text);
					input.focused = true;
					move(input);

					const [line] = input.render(width);
					assert.ok(line);
					assert.ok(visibleWidth(line) <= width, `rendered line overflowed for ${text} at ${label}`);
				}
			}
		});

		it("keeps the cursor visible when horizontally scrolling wide text", () => {
			const input = new Input();
			const width = 20;
			const text = "가나다라마바사아자차카타파하";
			input.setValue(text);
			input.focused = true;
			input.handleInput("\x01");
			for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");

			const [line] = input.render(width);
			assert.ok(line);
			assert.ok(visibleWidth(line) <= width);
		});
	});

	describe("Kill ring", () => {
		it("Ctrl+W saves deleted text to kill ring and Ctrl+Y yanks it", () => {
			const input = new Input();

			input.setValue("foo bar baz");
			// 将光标移至末尾。
			input.handleInput("\x05"); // Ctrl+E

			input.handleInput("\x17"); // Ctrl+W 删除 "baz"。
			assert.strictEqual(input.getValue(), "foo bar ");

			// 将光标移至开头并粘贴。
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "bazfoo bar ");
		});

		it("Ctrl+W preserves ASCII punctuation boundaries", () => {
			const input = new Input();

			input.setValue("foo.bar");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "bar"。
			assert.strictEqual(input.getValue(), "foo.");

			input.setValue("foo:bar");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "bar"。
			assert.strictEqual(input.getValue(), "foo:");
		});

		it("Ctrl+W handles Unicode word boundaries", () => {
			const input = new Input();

			// "你好世界。你好，世界" 的分段结果为：你好|世界|。|你好|，|世界。
			input.setValue("你好世界。你好，世界");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "世界"。
			assert.strictEqual(input.getValue(), "你好世界。你好，");
			input.handleInput("\x17"); // Ctrl+W 删除 "，"。
			assert.strictEqual(input.getValue(), "你好世界。你好");
			input.handleInput("\x17"); // Ctrl+W 删除 "你好"。
			assert.strictEqual(input.getValue(), "你好世界。");
			input.handleInput("\x17"); // Ctrl+W 删除 "。"。
			assert.strictEqual(input.getValue(), "你好世界");
			input.handleInput("\x17"); // Ctrl+W 删除 "世界"。
			assert.strictEqual(input.getValue(), "你好");
			input.handleInput("\x17"); // Ctrl+W 删除 "你好"。
			assert.strictEqual(input.getValue(), "");
		});

		it("Ctrl+U saves deleted text to kill ring", () => {
			const input = new Input();

			input.setValue("hello world");
			// 将光标移至 "hello " 之后。
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x15"); // Ctrl+U 删除 "hello "。
			assert.strictEqual(input.getValue(), "world");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("Ctrl+K saves deleted text to kill ring", () => {
			const input = new Input();

			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x0b"); // Ctrl+K 删除 "hello world"。

			assert.strictEqual(input.getValue(), "");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("Ctrl+Y does nothing when kill ring is empty", () => {
			const input = new Input();

			input.setValue("test");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "test");
		});

		it("Alt+Y cycles through kill ring after Ctrl+Y", () => {
			const input = new Input();

			// 创建包含多个条目的剪切环。
			input.setValue("first");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "first"。
			input.setValue("second");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "second"。
			input.setValue("third");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "third"。

			assert.strictEqual(input.getValue(), "");

			input.handleInput("\x19"); // Ctrl+Y 粘贴 "third"。
			assert.strictEqual(input.getValue(), "third");

			input.handleInput("\x1by"); // Alt+Y 切换到“second”。
			assert.strictEqual(input.getValue(), "second");

			input.handleInput("\x1by"); // Alt+Y 切换到“first”。
			assert.strictEqual(input.getValue(), "first");

			input.handleInput("\x1by"); // Alt+Y 再次切换到 "third"。
			assert.strictEqual(input.getValue(), "third");
		});

		it("Alt+Y does nothing if not preceded by yank", () => {
			const input = new Input();

			input.setValue("test");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "test"。
			input.setValue("other");
			input.handleInput("\x05"); // Ctrl+E

			// 输入内容以中断连续粘贴链。
			input.handleInput("x");
			assert.strictEqual(input.getValue(), "otherx");

			input.handleInput("\x1by"); // Alt+Y 不应执行任何操作。
			assert.strictEqual(input.getValue(), "otherx");
		});

		it("Alt+Y does nothing if kill ring has one entry", () => {
			const input = new Input();

			input.setValue("only");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "only"。

			input.handleInput("\x19"); // Ctrl+Y 粘贴 "only"。
			assert.strictEqual(input.getValue(), "only");

			input.handleInput("\x1by"); // Alt+Y 不应执行任何操作。
			assert.strictEqual(input.getValue(), "only");
		});

		it("consecutive Ctrl+W accumulates into one kill ring entry", () => {
			const input = new Input();

			input.setValue("one two three");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "three"。
			input.handleInput("\x17"); // Ctrl+W 删除 "two "。
			input.handleInput("\x17"); // Ctrl+W 删除 "one "。

			assert.strictEqual(input.getValue(), "");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "one two three");
		});

		it("non-delete actions break kill accumulation", () => {
			const input = new Input();

			input.setValue("foo bar baz");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "baz"。
			assert.strictEqual(input.getValue(), "foo bar ");

			input.handleInput("x"); // 输入字符会中断连续累积。
			assert.strictEqual(input.getValue(), "foo bar x");

			input.handleInput("\x17"); // Ctrl+W 删除 "x" (separate entry)。
			assert.strictEqual(input.getValue(), "foo bar ");

			input.handleInput("\x19"); // Ctrl+Y：最近复制的内容为“x”。
			assert.strictEqual(input.getValue(), "foo bar x");

			input.handleInput("\x1by"); // Alt+Y：轮换到“baz”。
			assert.strictEqual(input.getValue(), "foo bar baz");
		});

		it("non-yank actions break Alt+Y chain", () => {
			const input = new Input();

			input.setValue("first");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W
			input.setValue("second");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W
			input.setValue("");

			input.handleInput("\x19"); // Ctrl+Y 粘贴 "second"。
			assert.strictEqual(input.getValue(), "second");

			input.handleInput("x"); // 输入字符会中断连续粘贴链。
			assert.strictEqual(input.getValue(), "secondx");

			input.handleInput("\x1by"); // Alt+Y 不应执行任何操作。
			assert.strictEqual(input.getValue(), "secondx");
		});

		it("kill ring rotation persists after cycling", () => {
			const input = new Input();

			input.setValue("first");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // 删除“first”。
			input.setValue("second");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // 删除“second”。
			input.setValue("third");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // 删除“third”。
			input.setValue("");

			input.handleInput("\x19"); // Ctrl+Y 粘贴 "third"。
			input.handleInput("\x1by"); // Alt+Y 切换到“second”。
			assert.strictEqual(input.getValue(), "second");

			// 中断当前链并重新开始。
			input.handleInput("x");
			input.setValue("");

			// 新的粘贴应得到 "second"（轮转后它位于末尾）。
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "second");
		});

		it("backward deletions prepend, forward deletions append during accumulation", () => {
			const input = new Input();

			input.setValue("prefix|suffix");
			// 将光标移至 "|" 所在位置。
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C"); // 向右移动 6 次。

			input.handleInput("\x0b"); // Ctrl+K 删除 "|suffix" (forward)。
			assert.strictEqual(input.getValue(), "prefix");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "prefix|suffix");
		});

		it("Alt+D deletes word forward and saves to kill ring", () => {
			const input = new Input();

			input.setValue("hello world test");
			input.handleInput("\x01"); // Ctrl+A

			input.handleInput("\x1bd"); // Alt+D 删除“hello”。
			assert.strictEqual(input.getValue(), " world test");

			input.handleInput("\x1bd"); // Alt+D 删除“ world”。
			assert.strictEqual(input.getValue(), " test");

			// 粘贴操作应得到累积的文本。
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello world test");
		});

		it("Alt+D preserves ASCII punctuation boundaries", () => {
			const input = new Input();

			input.setValue("foo.bar baz");
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x1bd"); // Alt+D 删除“foo”。
			assert.strictEqual(input.getValue(), ".bar baz");
			input.handleInput("\x1bd"); // Alt+D 删除“.”。
			assert.strictEqual(input.getValue(), "bar baz");
			input.handleInput("\x1bd"); // Alt+D 删除“bar”。
			assert.strictEqual(input.getValue(), " baz");
		});

		it("Alt+D handles Unicode word boundaries", () => {
			const input = new Input();

			// "你好世界。你好，世界" 的分段结果为：你好|世界|。|你好|，|世界。
			input.setValue("你好世界。你好，世界");
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x1bd"); // Alt+D 删除“你好”。
			assert.strictEqual(input.getValue(), "世界。你好，世界");
			input.handleInput("\x1bd"); // Alt+D 删除“世界”。
			assert.strictEqual(input.getValue(), "。你好，世界");
			input.handleInput("\x1bd"); // Alt+D 删除“。”。
			assert.strictEqual(input.getValue(), "你好，世界");
			input.handleInput("\x1bd"); // Alt+D 删除“你好”。
			assert.strictEqual(input.getValue(), "，世界");
			input.handleInput("\x1bd"); // Alt+D 删除“，”。
			assert.strictEqual(input.getValue(), "世界");
			input.handleInput("\x1bd"); // Alt+D 删除“世界”。
			assert.strictEqual(input.getValue(), "");
		});

		it("handles yank in middle of text", () => {
			const input = new Input();

			input.setValue("word");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "word"。
			input.setValue("hello world");
			// 将光标移至中间（"hello " 之后）。
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello wordworld");
		});

		it("handles yank-pop in middle of text", () => {
			const input = new Input();

			// 创建两个剪切环条目。
			input.setValue("FIRST");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "FIRST"。
			input.setValue("SECOND");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W 删除 "SECOND"。

			// 准备文本 "hello world"，并将光标置于 "hello " 之后。
			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x19"); // Ctrl+Y 粘贴 "SECOND"。
			assert.strictEqual(input.getValue(), "hello SECONDworld");

			input.handleInput("\x1by"); // Alt+Y 将内容替换为 "FIRST"。
			assert.strictEqual(input.getValue(), "hello FIRSTworld");
		});
	});

	describe("Undo", () => {
		it("does nothing when undo stack is empty", () => {
			const input = new Input();

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "");
		});

		it("coalesces consecutive word characters into one undo unit", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			assert.strictEqual(input.getValue(), "hello world");

			// 撤销操作会删除 " world"。
			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "hello");

			// 撤销操作会删除 "hello"。
			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "");
		});

		it("undoes spaces one at a time", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput(" ");
			assert.strictEqual(input.getValue(), "hello  ");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销并移除第二个空格。
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销并移除第一个空格。
			assert.strictEqual(input.getValue(), "hello");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。 - removes "hello"
			assert.strictEqual(input.getValue(), "");
		});

		it("undoes backspace", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput("\x7f"); // 退格键。
			assert.strictEqual(input.getValue(), "hell");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "hello");
		});

		it("undoes forward delete", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput("\x01"); // Ctrl+A：移至行首。
			input.handleInput("\x1b[C"); // 右方向键。
			input.handleInput("\x1b[3~"); // Delete 键。
			assert.strictEqual(input.getValue(), "hllo");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "hello");
		});

		it("undoes Ctrl+W (delete word backward)", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			assert.strictEqual(input.getValue(), "hello world");

			input.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes Ctrl+K (delete to line end)", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x0b"); // Ctrl+K
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes Ctrl+U (delete to line start)", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(input.getValue(), "world");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes yank", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("\x17"); // Ctrl+W：删除“hello ”。
			input.handleInput("\x19"); // Ctrl+Y：粘贴剪切环中的内容。
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "");
		});

		it("undoes paste atomically", () => {
			const input = new Input();

			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");

			// 模拟带括号标记的粘贴。
			input.handleInput("\x1b[200~beep boop\x1b[201~");
			assert.strictEqual(input.getValue(), "hellobeep boop world");

			// 一次撤销应恢复粘贴前的全部状态。
			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes Alt+D (delete word forward)", () => {
			const input = new Input();

			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A

			input.handleInput("\x1bd"); // Alt+D 删除“hello”。
			assert.strictEqual(input.getValue(), " world");

			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("cursor movement starts new undo unit", () => {
			const input = new Input();

			input.handleInput("a");
			input.handleInput("b");
			input.handleInput("c");
			input.handleInput("\x01"); // Ctrl+A：移动光标会中断连续合并。
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("d");
			input.handleInput("e");
			assert.strictEqual(input.getValue(), "abcde");

			// 撤销操作会删除移动光标后输入的 "de"。
			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "abc");

			// 撤销操作会删除 "abc"。
			input.handleInput("\x1b[45;5u"); // Ctrl+-：撤销。
			assert.strictEqual(input.getValue(), "");
		});
	});
});
