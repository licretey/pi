import { describe, expect, it } from "vitest";
import type { ShellOutputSkip } from "../src/env/index.ts";
import { OutputBuffer, type OutputLimits } from "../src/harness/output.ts";

/** 使用确定性的伪随机数生成器（mulberry32），以便根据输出的种子复现失败。 */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// 解码后的 shell 输出：包含 ASCII、多字节和辅助平面字符、替换字符、CR/LF、制表符，
// 以及在截断后清理过程中会被移除的控制字符。
const ALPHABET = ["a", "b", "z", " ", "\n", "\n", "\n", "\r\n", "\t", "é", "€", "😀", "\ufffd", "\x01", "\x1b"];

function randomChunk(next: () => number): string {
	const length = Math.floor(next() * 12);
	let text = "";
	for (let index = 0; index < length; index++) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
	return text;
}

function measure(text: string): ShellOutputSkip {
	let newlines = 0;
	for (const character of text) if (character === "\n") newlines++;
	return { bytes: Buffer.byteLength(text, "utf8"), newlines, endsWithNewline: text.endsWith("\n") };
}

/** 判断 `text` 是否能证明其之前的所有内容都已超出尾部窗口。 */
function exceedsWindow(text: string, limits: OutputLimits): boolean {
	const { bytes, newlines } = measure(text);
	return bytes > limits.maxBytes || newlines > limits.maxLines;
}

/** 返回 `text` 的码点边界，确保截断时不会拆开代理项对。 */
function boundaries(text: string): number[] {
	const result = [0];
	let offset = 0;
	for (const character of text) {
		offset += character.length;
		result.push(offset);
	}
	return result;
}

/**
 * 将随机输出完整写入一个缓冲区，并通过符合 `ShellOutputInfo.skipped` 契约的参考跳过器写入另一个缓冲区：
 * 它会暂存尚未送达的文本；刷新时，如果剩余内容超出窗口，可用计数信息替换其前缀。
 * 两个缓冲区处理相同输出后，其快照必须一致。
 */
function checkSeed(seed: number): void {
	const next = random(seed);
	const limits: OutputLimits = {
		maxBytes: 1 + Math.floor(next() * 40),
		maxLines: 1 + Math.floor(next() * 5),
		retain: "tail",
	};
	const full = new OutputBuffer(limits);
	const skipping = new OutputBuffer(limits);
	let pending = "";
	let skips = 0;
	const flush = (): void => {
		if (pending === "") return;
		const cuts = boundaries(pending).filter((cut) => cut > 0 && exceedsWindow(pending.slice(cut), limits));
		if (cuts.length > 0 && next() < 0.7) {
			const cut = cuts[Math.floor(next() * cuts.length)]!;
			skipping.push(pending.slice(cut), measure(pending.slice(0, cut)));
			skips++;
		} else {
			skipping.push(pending);
		}
		pending = "";
		// 进度快照会在数据送达之间生成，并压缩已存储的数据块。
		if (next() < 0.5) skipping.snapshot();
		expect(skipping.snapshot(), `seed ${seed}`).toEqual(full.snapshot());
	};
	const chunks = Math.floor(next() * 40);
	for (let index = 0; index < chunks; index++) {
		const chunk = randomChunk(next);
		full.push(chunk);
		if (next() < 0.3) full.snapshot();
		pending += chunk;
		if (next() < 0.3) flush();
	}
	flush();
	full.end();
	skipping.end();
	expect(skipping.snapshot(), `seed ${seed}`).toEqual(full.snapshot());
	expect(skips >= 0).toBe(true);
}

describe("OutputBuffer skipped output", () => {
	// 进度提交可能在任意时刻生成快照；快照会压缩已存储内容，但绝不能改变窗口范围。
	// 如果压缩结果恰好等于保留窗口，就会丢失用于确定后续窗口首行起点的字符。
	it("keeps the same tail whenever progress snapshots happen", () => {
		for (let seed = 1; seed <= 3000; seed++) {
			const next = random(seed);
			const limits: OutputLimits = {
				maxBytes: 1 + Math.floor(next() * 40),
				maxLines: 1 + Math.floor(next() * 5),
				retain: "tail",
			};
			const plain = new OutputBuffer(limits);
			const sampled = new OutputBuffer(limits);
			const chunks = Math.floor(next() * 30);
			for (let index = 0; index < chunks; index++) {
				const chunk = randomChunk(next);
				plain.push(chunk);
				sampled.push(chunk);
				if (next() < 0.4) sampled.snapshot();
			}
			expect(sampled.snapshot(), `seed ${seed}`).toEqual(plain.snapshot());
		}
	});

	it("matches the full stream for every legal skip pattern", () => {
		for (let seed = 1; seed <= 3000; seed++) checkSeed(seed);
	});

	it("counts skipped bytes, lines and the final newline exactly", () => {
		const limits: OutputLimits = { maxBytes: 1000, maxLines: 2, retain: "tail" };
		const full = new OutputBuffer(limits);
		const skipping = new OutputBuffer(limits);
		// 被跳过的文本末尾没有换行符，因此最后一行会与后续送达的文本连在一起。
		const omitted = "one\ntwo\nthr";
		const kept = "ee\nfour\nfive\nsix";
		full.push(omitted + kept);
		skipping.push(kept, measure(omitted));
		expect(skipping.snapshot()).toEqual(full.snapshot());
		expect(skipping.snapshot()).toEqual({ text: "five\nsix", droppedBytes: 19, droppedLines: 4 });
	});

	it("refuses skips for head retention", () => {
		const buffer = new OutputBuffer({ maxBytes: 10, maxLines: 2, retain: "head" });
		expect(() => buffer.push("x\ny\nz\n", { bytes: 3, newlines: 1, endsWithNewline: true })).toThrow(
			"tail retention",
		);
	});
});
