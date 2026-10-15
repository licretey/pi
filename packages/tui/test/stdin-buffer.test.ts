/**
 * StdinBuffer 的测试。
 *
 * 基于 OpenTUI（https://github.com/anomalyco/opentui）的代码。
 * MIT License - Copyright (c) 2025 opentui
 */

import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { matchesKey } from "../src/keys.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";

describe("StdinBuffer", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		buffer = new StdinBuffer({ timeout: 10 });

		// 收集已发出的序列。
		emittedSequences = [];
		buffer.on("data", (sequence) => {
			emittedSequences.push(sequence);
		});
	});

	// 将数据传入缓冲区处理。
	function processInput(data: string | Buffer): void {
		buffer.process(data);
	}

	// 等待异步操作完成。
	async function wait(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	describe("Regular Characters", () => {
		it("should pass through regular characters immediately", () => {
			processInput("a");
			assert.deepStrictEqual(emittedSequences, ["a"]);
		});

		it("should pass through multiple regular characters", () => {
			processInput("abc");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c"]);
		});

		it("should handle unicode characters", () => {
			processInput("hello 世界");
			assert.deepStrictEqual(emittedSequences, ["h", "e", "l", "l", "o", " ", "世", "界"]);
		});
	});

	describe("Complete Escape Sequences", () => {
		it("should pass through complete mouse SGR sequences", () => {
			const mouseSeq = "\x1b[<35;20;5m";
			processInput(mouseSeq);
			assert.deepStrictEqual(emittedSequences, [mouseSeq]);
		});

		it("should pass through complete arrow key sequences", () => {
			const upArrow = "\x1b[A";
			processInput(upArrow);
			assert.deepStrictEqual(emittedSequences, [upArrow]);
		});

		it("should pass through complete function key sequences", () => {
			const f1 = "\x1b[11~";
			processInput(f1);
			assert.deepStrictEqual(emittedSequences, [f1]);
		});

		it("should pass through meta key sequences", () => {
			const metaA = "\x1ba";
			processInput(metaA);
			assert.deepStrictEqual(emittedSequences, [metaA]);
		});

		it("should pass through SS3 sequences", () => {
			const ss3 = "\x1bOA";
			processInput(ss3);
			assert.deepStrictEqual(emittedSequences, [ss3]);
		});
	});

	describe("Partial Escape Sequences", () => {
		it("should buffer incomplete mouse SGR sequence", async () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);
			assert.strictEqual(buffer.getBuffer(), "\x1b");

			processInput("[<35");
			assert.deepStrictEqual(emittedSequences, []);
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			processInput(";20;5m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
			assert.strictEqual(buffer.getBuffer(), "");
		});

		it("should buffer incomplete CSI sequence", () => {
			processInput("\x1b[");
			assert.deepStrictEqual(emittedSequences, []);

			processInput("1;");
			assert.deepStrictEqual(emittedSequences, []);

			processInput("5H");
			assert.deepStrictEqual(emittedSequences, ["\x1b[1;5H"]);
		});

		it("should buffer split across many chunks", () => {
			processInput("\x1b");
			processInput("[");
			processInput("<");
			processInput("3");
			processInput("5");
			processInput(";");
			processInput("2");
			processInput("0");
			processInput(";");
			processInput("5");
			processInput("m");

			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
		});

		it("should flush incomplete sequence after timeout", async () => {
			processInput("\x1b[<35");
			assert.deepStrictEqual(emittedSequences, []);

			// 等待超时。
			await wait(15);

			assert.deepStrictEqual(emittedSequences, ["\x1b[<35"]);
		});

		it("should flush a lone ESC as Escape when CR arrives after the timeout", async () => {
			// 传统模式下，Alt+Enter 对应 ESC + CR；若终端或传输层拆分字节的间隔超过超时时长，
			// ESC 会单独刷新，宿主端收到的是 Escape（中断），而不是 Alt+Enter。此测试固定该行为，
			// 确保 ProcessTerminal 的可配置超时时长与实际行为一致。
			processInput("\x1b");
			await wait(20); // beforeEach 中将缓冲区超时时长设为 10 毫秒。
			processInput("\r");

			assert.deepStrictEqual(emittedSequences, ["\x1b", "\r"]);
			assert.equal(matchesKey(emittedSequences[0] ?? "", "escape"), true);
		});

		it("should merge ESC + CR split across chunks within a larger timeout", async () => {
			buffer = new StdinBuffer({ escapeTimeout: 100 });
			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			processInput("\x1b");
			await wait(20); // 大于 escapeTimeout 的默认值 10 毫秒，小于配置值 100 毫秒。
			processInput("\r");

			assert.deepStrictEqual(emittedSequences, ["\x1b\r"]);
			assert.equal(matchesKey(emittedSequences[0] ?? "", "alt+enter"), true);
		});

		it("does not apply the sequence timeout to a lone ESC", async () => {
			buffer = new StdinBuffer({ timeout: 100 });
			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			processInput("\x1b");
			await wait(20);
			processInput("\r");

			assert.deepStrictEqual(emittedSequences, ["\x1b", "\r"]);
			assert.equal(matchesKey(emittedSequences[0] ?? "", "escape"), true);
		});

		it("keeps fragmented mouse sequences buffered across delayed chunks by default", async () => {
			const delayedBuffer = new StdinBuffer();
			const delayedSequences: string[] = [];
			delayedBuffer.on("data", (sequence) => delayedSequences.push(sequence));

			delayedBuffer.process("\x1b[");
			await wait(20);
			assert.deepStrictEqual(delayedSequences, []);
			delayedBuffer.process("<65;48;39M");
			assert.deepStrictEqual(delayedSequences, ["\x1b[<65;48;39M"]);
			delayedBuffer.destroy();
		});
	});

	describe("Mixed Content", () => {
		it("should handle characters followed by escape sequence", () => {
			processInput("abc\x1b[A");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c", "\x1b[A"]);
		});

		it("should handle escape sequence followed by characters", () => {
			processInput("\x1b[Aabc");
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "a", "b", "c"]);
		});

		it("should handle multiple complete sequences", () => {
			processInput("\x1b[A\x1b[B\x1b[C");
			assert.deepStrictEqual(emittedSequences, ["\x1b[A", "\x1b[B", "\x1b[C"]);
		});

		it("should handle partial sequence with preceding characters", () => {
			processInput("abc\x1b[<35");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c"]);
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			processInput(";20;5m");
			assert.deepStrictEqual(emittedSequences, ["a", "b", "c", "\x1b[<35;20;5m"]);
		});
	});

	describe("Kitty Keyboard Protocol", () => {
		it("should handle Kitty CSI u press events", () => {
			// Kitty 协议中的 a 键按下事件。
			processInput("\x1b[97u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u"]);
		});

		it("should handle Kitty CSI u release events", () => {
			// Kitty 协议中的 a 键释放事件。
			processInput("\x1b[97;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97;1:3u"]);
		});

		it("should handle batched Kitty press and release", () => {
			// a 键的按下和释放事件合并到同一批数据中（SSH 场景中很常见）。
			processInput("\x1b[97u\x1b[97;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "\x1b[97;1:3u"]);
		});

		it("should handle multiple batched Kitty events", () => {
			// 依次包含 a 键按下、a 键释放、b 键按下和 b 键释放事件。
			processInput("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]);
		});

		it("should handle Kitty arrow keys with event type", () => {
			// 带事件类型的上方向键按下事件。
			processInput("\x1b[1;1:1A");
			assert.deepStrictEqual(emittedSequences, ["\x1b[1;1:1A"]);
		});

		it("should handle Kitty functional keys with event type", () => {
			// Delete 键释放事件。
			processInput("\x1b[3;1:3~");
			assert.deepStrictEqual(emittedSequences, ["\x1b[3;1:3~"]);
		});

		it("should split ESC+ESC+CSI into standalone ESC and the CSI sequence (WezTerm Escape key regression)", () => {
			// WezTerm 启用 enable_kitty_keyboard 后，会将 Escape 键按下事件作为原始 \x1b 发送，
			// 并将释放事件作为完整的 Kitty CSI-u 序列紧接着发送。
			// 如果后续字节开始了新的转义序列，缓冲区不能把 \x1b\x1b 当作完整的 Meta 组合键。
			processInput("\x1b\x1b[27;129:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\x1b[27;129:3u"]);
		});

		it("should split ESC+ESC+CSI with no modifier (no num_lock)", () => {
			processInput("\x1b\x1b[27;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b", "\x1b[27;1:3u"]);
		});

		it("should still emit ESC+ESC as a single sequence when not followed by a new escape", () => {
			// 单独出现的 \x1b\x1b（后面没有 CSI）应保持原样，例如 ctrl+alt+[。
			processInput("\x1b\x1b");
			assert.deepStrictEqual(emittedSequences, ["\x1b\x1b"]);
		});

		it("should handle plain characters mixed with Kitty sequences", () => {
			// 普通字符 a 后跟 Kitty 协议的按键释放事件。
			processInput("a\x1b[97;1:3u");
			assert.deepStrictEqual(emittedSequences, ["a", "\x1b[97;1:3u"]);
		});

		it("should drop raw duplicate character after matching Kitty printable sequence", () => {
			processInput("\x1b[224uà");
			assert.deepStrictEqual(emittedSequences, ["\x1b[224u"]);
		});

		it("should drop raw duplicate character after matching Kitty printable sequence across chunks", () => {
			processInput("\x1b[64u");
			processInput("@");
			assert.deepStrictEqual(emittedSequences, ["\x1b[64u"]);
		});

		it("should keep non-matching plain character after Kitty printable sequence", () => {
			processInput("\x1b[97ub");
			assert.deepStrictEqual(emittedSequences, ["\x1b[97u", "b"]);
		});

		it("should keep raw character after modified Kitty printable sequence", () => {
			processInput("\x1b[64;3u@");
			assert.deepStrictEqual(emittedSequences, ["\x1b[64;3u", "@"]);
		});

		it("should handle rapid typing simulation with Kitty protocol", () => {
			// 模拟快速输入 hi，按键释放事件穿插在按下事件之间。
			processInput("\x1b[104u\x1b[104;1:3u\x1b[105u\x1b[105;1:3u");
			assert.deepStrictEqual(emittedSequences, ["\x1b[104u", "\x1b[104;1:3u", "\x1b[105u", "\x1b[105;1:3u"]);
		});
	});

	describe("Mouse Events", () => {
		it("should handle mouse press event", () => {
			processInput("\x1b[<0;10;5M");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<0;10;5M"]);
		});

		it("should handle mouse release event", () => {
			processInput("\x1b[<0;10;5m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<0;10;5m"]);
		});

		it("should handle mouse move event", () => {
			processInput("\x1b[<35;20;5m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;20;5m"]);
		});

		it("should handle split mouse events", () => {
			processInput("\x1b[<3");
			processInput("5;1");
			processInput("5;");
			processInput("10m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;15;10m"]);
		});

		it("should handle multiple mouse events", () => {
			processInput("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m");
			assert.deepStrictEqual(emittedSequences, ["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]);
		});

		it("should handle old-style mouse sequence (ESC[M + 3 bytes)", () => {
			processInput("\x1b[M abc");
			assert.deepStrictEqual(emittedSequences, ["\x1b[M ab", "c"]);
		});

		it("should buffer incomplete old-style mouse sequence", () => {
			processInput("\x1b[M");
			assert.strictEqual(buffer.getBuffer(), "\x1b[M");

			processInput(" a");
			assert.strictEqual(buffer.getBuffer(), "\x1b[M a");

			processInput("b");
			assert.deepStrictEqual(emittedSequences, ["\x1b[M ab"]);
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty input", () => {
			processInput("");
			// 空字符串会触发内容为空的数据事件。
			assert.deepStrictEqual(emittedSequences, [""]);
		});

		it("should handle lone escape character with timeout", async () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);

			// 超时后应发出该序列。
			await wait(15);
			assert.deepStrictEqual(emittedSequences, ["\x1b"]);
		});

		it("flushes a lone escape promptly with the longer default sequence timeout", async () => {
			const defaultBuffer = new StdinBuffer();
			const defaultSequences: string[] = [];
			defaultBuffer.on("data", (sequence) => defaultSequences.push(sequence));

			defaultBuffer.process("\x1b");
			await wait(20);
			assert.deepStrictEqual(defaultSequences, ["\x1b"]);
			defaultBuffer.destroy();
		});

		it("should handle lone escape character with explicit flush", () => {
			processInput("\x1b");
			assert.deepStrictEqual(emittedSequences, []);

			const flushed = buffer.flush();
			assert.deepStrictEqual(flushed, ["\x1b"]);
		});

		it("should handle buffer input", () => {
			processInput(Buffer.from("\x1b[A"));
			assert.deepStrictEqual(emittedSequences, ["\x1b[A"]);
		});

		it("should handle very long sequences", () => {
			const longSeq = `\x1b[${"1;".repeat(50)}H`;
			processInput(longSeq);
			assert.deepStrictEqual(emittedSequences, [longSeq]);
		});
	});

	describe("Flush", () => {
		it("should flush incomplete sequences", () => {
			processInput("\x1b[<35");
			const flushed = buffer.flush();
			assert.deepStrictEqual(flushed, ["\x1b[<35"]);
			assert.strictEqual(buffer.getBuffer(), "");
		});

		it("should return empty array if nothing to flush", () => {
			const flushed = buffer.flush();
			assert.deepStrictEqual(flushed, []);
		});

		it("should emit flushed data via timeout", async () => {
			processInput("\x1b[<35");
			assert.deepStrictEqual(emittedSequences, []);

			// 等待超时后刷新缓冲内容。
			await wait(15);

			assert.deepStrictEqual(emittedSequences, ["\x1b[<35"]);
		});
	});

	describe("Clear", () => {
		it("should clear buffered content without emitting", () => {
			processInput("\x1b[<35");
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			buffer.clear();
			assert.strictEqual(buffer.getBuffer(), "");
			assert.deepStrictEqual(emittedSequences, []);
		});
	});

	describe("Bracketed Paste", () => {
		let emittedPaste: string[] = [];

		beforeEach(() => {
			buffer = new StdinBuffer({ timeout: 10 });

			// 收集已发出的序列。
			emittedSequences = [];
			buffer.on("data", (sequence) => {
				emittedSequences.push(sequence);
			});

			// 收集粘贴事件。
			emittedPaste = [];
			buffer.on("paste", (data) => {
				emittedPaste.push(data);
			});
		});

		it("should emit paste event for complete bracketed paste", () => {
			const pasteStart = "\x1b[200~";
			const pasteEnd = "\x1b[201~";
			const content = "hello world";

			processInput(pasteStart + content + pasteEnd);

			assert.deepStrictEqual(emittedPaste, ["hello world"]);
			assert.deepStrictEqual(emittedSequences, []); // 粘贴期间不会触发 data 事件。
		});

		it("should handle paste arriving in chunks", () => {
			processInput("\x1b[200~");
			assert.deepStrictEqual(emittedPaste, []);

			processInput("hello ");
			assert.deepStrictEqual(emittedPaste, []);

			processInput("world\x1b[201~");
			assert.deepStrictEqual(emittedPaste, ["hello world"]);
			assert.deepStrictEqual(emittedSequences, []);
		});

		it("should handle paste with input before and after", () => {
			processInput("a");
			processInput("\x1b[200~pasted\x1b[201~");
			processInput("b");

			assert.deepStrictEqual(emittedSequences, ["a", "b"]);
			assert.deepStrictEqual(emittedPaste, ["pasted"]);
		});

		it("should handle paste with newlines", () => {
			processInput("\x1b[200~line1\nline2\nline3\x1b[201~");

			assert.deepStrictEqual(emittedPaste, ["line1\nline2\nline3"]);
			assert.deepStrictEqual(emittedSequences, []);
		});

		it("should handle paste with unicode", () => {
			processInput("\x1b[200~Hello 世界 🎉\x1b[201~");

			assert.deepStrictEqual(emittedPaste, ["Hello 世界 🎉"]);
			assert.deepStrictEqual(emittedSequences, []);
		});
	});

	describe("Destroy", () => {
		it("should clear buffer on destroy", () => {
			processInput("\x1b[<35");
			assert.strictEqual(buffer.getBuffer(), "\x1b[<35");

			buffer.destroy();
			assert.strictEqual(buffer.getBuffer(), "");
		});

		it("should clear pending timeouts on destroy", async () => {
			processInput("\x1b[<35");
			buffer.destroy();

			// 等待时间超过超时时长。
			await wait(15);

			// 不应发出任何内容。
			assert.deepStrictEqual(emittedSequences, []);
		});
	});
});
