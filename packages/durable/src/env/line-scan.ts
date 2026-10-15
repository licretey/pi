import { rangeDecoder, startsWithBom } from "./decode.ts";
import type { LineScan } from "./index.ts";

const NEWLINE = 0x0a;
const encoder = new TextEncoder();

/** 解码后文本的 UTF-8 字节长度。 */
function decodedBytes(text: string): number {
	return text === "" ? 0 : encoder.encode(text).length;
}

/**
 * 按顺序接收文件的字节流并计算出 `LineScan`，环境因此能在有限内存内扫描任意大小的文件。解码大小的计算
 * 与一次性解码整个文件使用的是同一个 WHATWG 流式解码器。
 */
export class LineScanner {
	readonly #startLine: number;
	readonly #endLine: number;
	#position = 0;
	#newlines = 0;
	#lineStart = 0;
	#start: number | undefined;
	#end: number | undefined;
	#firstLineEnd: number | undefined;
	#lastLineStart: number | undefined;
	#selectedBytes = 0;
	#firstLineBytes = 0;
	#selection: InstanceType<typeof TextDecoder> | undefined;
	#firstLine: InstanceType<typeof TextDecoder> | undefined;
	/** 文件最初的字节，先扣住不放，直到确认它们是否为字节序标记。 */
	#head: number[] | undefined = [];
	#bom = false;

	/** `startLine` 与 `endLine` 必须是非负整数且 `endLine > startLine`；缺省 `endLine` 表示直到结尾。 */
	constructor(startLine: number, endLine = Number.POSITIVE_INFINITY) {
		if (!Number.isSafeInteger(startLine) || startLine < 0 || !(endLine > startLine)) {
			throw new RangeError("Invalid line range");
		}
		if (endLine !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(endLine))
			throw new RangeError("Invalid line range");
		this.#startLine = startLine;
		this.#endLine = endLine;
		if (startLine === 0) this.#begin(0);
	}

	push(chunk: Uint8Array): void {
		if (this.#head !== undefined) {
			const take = Math.min(3 - this.#head.length, chunk.length);
			this.#head.push(...chunk.subarray(0, take));
			if (this.#head.length < 3) return;
			this.#releaseHead();
			chunk = chunk.subarray(take);
		}
		this.#process(chunk);
	}

	#releaseHead(): void {
		const head = Uint8Array.from(this.#head ?? []);
		this.#head = undefined;
		this.#bom = startsWithBom(head);
		this.#process(head);
	}

	#process(chunk: Uint8Array): void {
		const base = this.#position;
		let from = 0;
		for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) {
			// 该换行符结束第 `this.#newlines` 行。仅当它位于选中行之间时才计入选择范围。
			this.#feed(chunk, base, from, index);
			const line = this.#newlines;
			const position = base + index;
			if (line === this.#startLine) this.#endFirstLine(position);
			if (line === this.#endLine - 1) this.#endSelection(position);
			this.#feed(chunk, base, index, index + 1);
			from = index + 1;
			this.#newlines++;
			this.#lineStart = position + 1;
			if (this.#newlines === this.#startLine) this.#begin(this.#lineStart);
			if (this.#newlines === this.#endLine - 1) this.#lastLineStart = this.#lineStart;
		}
		this.#feed(chunk, base, from, chunk.length);
		this.#position += chunk.length;
	}

	finish(): LineScan {
		if (this.#head !== undefined) this.#releaseHead();
		const size = this.#position;
		if (this.#start === undefined) {
			return {
				newlines: this.#newlines,
				start: size,
				end: size,
				firstLineEnd: size,
				lastLineStart: size,
				selectedBytes: 0,
				firstLineBytes: 0,
			};
		}
		if (this.#firstLineEnd === undefined) this.#endFirstLine(size);
		if (this.#end === undefined) this.#endSelection(size);
		return {
			newlines: this.#newlines,
			start: this.#start,
			end: this.#end ?? size,
			firstLineEnd: this.#firstLineEnd ?? size,
			// 越过最后一行的选择，以最后一行为其终点。
			lastLineStart: this.#lastLineStart ?? this.#lineStart,
			selectedBytes: this.#selectedBytes,
			firstLineBytes: this.#firstLineBytes,
		};
	}

	#begin(start: number): void {
		this.#start = start;
		if (this.#startLine === this.#endLine - 1) this.#lastLineStart = start;
		this.#selection = rangeDecoder();
		this.#firstLine = rangeDecoder();
	}

	#endFirstLine(position: number): void {
		this.#firstLineEnd = position;
		if (this.#firstLine !== undefined) this.#firstLineBytes += decodedBytes(this.#firstLine.decode());
		this.#firstLine = undefined;
	}

	#endSelection(position: number): void {
		this.#end = position;
		if (this.#selection !== undefined) this.#selectedBytes += decodedBytes(this.#selection.decode());
		this.#selection = undefined;
	}

	/** 把从文件偏移 `base` 处开始的 `chunk[from, to)` 字节，喂给那些尚未闭合的范围所对应的解码器。 */
	#feed(chunk: Uint8Array, base: number, from: number, to: number): void {
		// 解码整个文件会丢掉文件开头的字节序标记。
		if (this.#bom && base + from < 3) from = Math.min(to, 3 - base);
		if (to <= from) return;
		const bytes = chunk.subarray(from, to);
		if (this.#selection !== undefined) {
			this.#selectedBytes += decodedBytes(this.#selection.decode(bytes, { stream: true }));
		}
		if (this.#firstLine !== undefined) {
			this.#firstLineBytes += decodedBytes(this.#firstLine.decode(bytes, { stream: true }));
		}
	}
}
