import type { ShellOutputSkip } from "../env/index.ts";
import { utf8ByteLength } from "../truncate.ts";

/** 单个工具输出的保留上限。 */
export type OutputLimits = { readonly maxBytes: number; readonly maxLines: number; readonly retain: "head" | "tail" };

/** 保留的输出，以及上限丢弃的部分。 */
export type BoundedOutput = { readonly text: string; readonly droppedBytes: number; readonly droppedLines: number };

/** 位于上限之内、对输入的精确切片，以及它省略的部分。 */
export type OutputSlice = {
	readonly text: string;
	readonly bytes: number;
	readonly droppedBytes: number;
	readonly droppedLines: number;
};

const NEWLINE = 0x0a;
const INVALID_OUTPUT = /[\x00-\x08\x0b-\x1f\ufff9-\ufffb]/g;
const encoder = new TextEncoder();
/** 切片解码是精确的：切片开头的 U+FEFF 是文本，而不是字节顺序标记。 */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** 移除破坏显示与 transcript 的控制字符；tab 和换行保留。 */
export function sanitizeOutput(text: string): string {
	return text.replace(INVALID_OUTPUT, "");
}

/**
 * 在上限内把 `text` 约束为整行：`head` 取前面的行，`tail` 取后面的行。结果是一个精确切片，含末尾换行。
 * 超过 `maxBytes` 的单行会在字节上限处按字符边界截断。
 */
export function boundOutput(text: string, limits: OutputLimits): OutputSlice {
	const bytes = encoder.encode(text);
	const [from, to] = limits.retain === "head" ? headRange(bytes, limits) : tailRange(bytes, limits);
	const kept = bytes.subarray(from, to);
	return {
		text: kept.length === bytes.length ? text : decoder.decode(kept),
		bytes: kept.length,
		droppedBytes: bytes.length - kept.length,
		droppedLines: lineCount(bytes) - lineCount(kept),
	};
}

function headRange(bytes: Uint8Array, limits: OutputLimits): [number, number] {
	if (limits.maxLines === 0 || limits.maxBytes === 0) return [0, 0];
	let end = bytes.length;
	let lines = 0;
	for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE, index + 1)) {
		if (++lines === limits.maxLines) {
			end = index + 1;
			break;
		}
	}
	if (end > limits.maxBytes) {
		const newline = bytes.lastIndexOf(NEWLINE, limits.maxBytes - 1);
		end = newline === -1 ? characterEnd(bytes, limits.maxBytes) : newline + 1;
	}
	return [0, end];
}

function tailRange(bytes: Uint8Array, limits: OutputLimits): [number, number] {
	if (limits.maxLines === 0 || limits.maxBytes === 0) return [bytes.length, bytes.length];
	// 末尾的换行结束最后一行，而不是开启新的一行。
	const last = bytes[bytes.length - 1] === NEWLINE ? bytes.length - 2 : bytes.length - 1;
	let start = 0;
	let lines = 1;
	for (let index = last < 0 ? -1 : bytes.lastIndexOf(NEWLINE, last); index !== -1; ) {
		if (lines === limits.maxLines) {
			start = index + 1;
			break;
		}
		lines++;
		index = index === 0 ? -1 : bytes.lastIndexOf(NEWLINE, index - 1);
	}
	if (bytes.length - start > limits.maxBytes) {
		const from = bytes.length - limits.maxBytes;
		const newline = bytes.indexOf(NEWLINE, from - 1);
		// 从字节窗口内开始的第一行，或当最后一行单独超长时对它的截断。
		start = newline !== -1 && newline + 1 < bytes.length ? newline + 1 : characterStart(bytes, from);
	}
	return [start, bytes.length];
}

/** `index` 处或之前最近的字符边界。 */
export function characterEnd(bytes: Uint8Array, index: number): number {
	let end = index;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return end;
}

/** `index` 处或之后最近的字符边界。 */
function characterStart(bytes: Uint8Array, index: number): number {
	let start = index;
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	return start;
}

function lineCount(bytes: Uint8Array): number {
	if (bytes.length === 0) return 0;
	let newlines = 0;
	for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE, index + 1)) newlines++;
	return newlines + (bytes[bytes.length - 1] === NEWLINE ? 0 : 1);
}

/**
 * 单个工具调用的有界运行中输出。接收一个 chunk 的时间代价与 chunk 大小成正比：head 保留在窗口填满后停止
 * 存储，tail 保留在快照时丢弃窗口不再需要的已存文本。
 * 整个流的计数都会保留，因此被丢弃的总量保持精确。
 */
export class OutputBuffer {
	readonly #limits: OutputLimits;
	/**
	 * 字节 chunk 的解码器。一个字符串 chunk 或一次 skip 会终结前序字节组成的不完整字符（使其变成 U+FFFD）；
	 * 随后的下一个字节 chunk 再开始一个新字符。与 `StreamDecoder` 一样，只有输出最开头的字节顺序标记会被
	 * 丢弃，更后面的 U+FEFF 绝不丢弃。
	 */
	readonly #decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	#started = false;
	/** 已存储的 chunks：head 模式保存流的开头，tail 模式保存仍包含下一个窗口的后缀。 */
	#chunks: { readonly text: string; readonly bytes: number; readonly newlines: number }[] = [];
	#storedBytes = 0;
	#storedNewlines = 0;
	#full = false;
	#totalBytes = 0;
	#totalNewlines = 0;
	#endsWithNewline = true;

	constructor(limits: OutputLimits) {
		this.#limits = limits;
	}

	/** 当前持有的字节数；以上限加一个 chunk 为界。 */
	get storedBytes(): number {
		return this.#storedBytes;
	}

	/**
	 * 接收一个 chunk；返回是否有内容被接收。`skipped` 是紧邻 chunk 之前被省略的输出，它必须比 tail 窗口还多
	 * 至少一个字节或一行（`ShellOutputInfo.skipped`）；只有 tail 保留模式接受它。
	 */
	push(chunk: string | Uint8Array, skipped?: ShellOutputSkip): boolean {
		// 前序字节 chunk 中不完整字符的字节放在最前。
		const pending = typeof chunk === "string" || skipped !== undefined ? this.#decoder.decode() : "";
		let text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
		const first = !this.#started && pending === "" && skipped === undefined;
		if (pending !== "" || text !== "" || skipped !== undefined) this.#started = true;
		if (first && typeof chunk !== "string" && text.startsWith("\ufeff")) text = text.slice(1);
		if (skipped === undefined) return this.#accept(pending + text);
		if (this.#limits.retain !== "tail") throw new Error("Skipped output requires tail retention");
		this.#accept(pending);
		this.#skip(skipped);
		this.#accept(text);
		return true;
	}

	/** 记入被省略的输出；一旦其后的文本到来，它之前存储的内容都不可能再进入窗口。 */
	#skip(skipped: ShellOutputSkip): void {
		if (skipped.bytes === 0) return;
		this.#totalBytes += skipped.bytes;
		this.#totalNewlines += skipped.newlines;
		this.#endsWithNewline = skipped.endsWithNewline;
		this.#chunks = [];
		this.#storedBytes = 0;
		this.#storedNewlines = 0;
	}

	/** 将末尾不完整的字符冲刷为替换字符；流结束时调用。 */
	end(): void {
		this.#accept(this.#decoder.decode());
	}

	#accept(text: string): boolean {
		if (text.length === 0) return false;
		const bytes = utf8ByteLength(text);
		const newlines = countNewlines(text);
		this.#totalBytes += bytes;
		this.#totalNewlines += newlines;
		this.#endsWithNewline = text.endsWith("\n");
		if (this.#full) return true;
		this.#chunks.push({ text, bytes, newlines });
		this.#storedBytes += bytes;
		this.#storedNewlines += newlines;
		if (this.#limits.retain === "head") {
			// 超出完整窗口之后的内容永远不会被需要。
			this.#full = this.#storedBytes > this.#limits.maxBytes || this.#storedNewlines >= this.#limits.maxLines;
			return true;
		}
		// 在其余内容仍多于一个窗口时丢弃头部 chunks：即多于 `maxBytes` 字节或多于 `maxLines`
		// 个换行再加一，这样窗口的行首仍能被找到。每个 chunk 只被丢弃一次。
		while (this.#chunks.length > 1) {
			const first = this.#chunks[0]!;
			const bytesAfter = this.#storedBytes - first.bytes;
			const newlinesAfter = this.#storedNewlines - first.newlines;
			if (bytesAfter <= this.#limits.maxBytes + 1 && newlinesAfter <= this.#limits.maxLines + 1) break;
			this.#chunks.shift();
			this.#storedBytes = bytesAfter;
			this.#storedNewlines = newlinesAfter;
		}
		return true;
	}

	/** 保留的、净化后的输出，以及上限从整个流中丢弃的部分。 */
	snapshot(): BoundedOutput {
		const stored =
			this.#chunks.length === 1 ? this.#chunks[0]!.text : this.#chunks.map((chunk) => chunk.text).join("");
		const kept = boundOutput(stored, this.#limits);
		const storedLines = lines(this.#storedNewlines, stored === "" || stored.endsWith("\n"));
		const keptLines = storedLines - kept.droppedLines;
		// tail 窗口不会回溯越过本窗口，但寻找更晚窗口的首行需要它之前的文本：
		// 像 `#accept` 那样，保留比窗口长一个字节或一行之后的最短后缀。
		if (this.#limits.retain === "tail" || this.#chunks.length > 1) {
			const text = this.#limits.retain === "tail" ? tailMargin(stored, this.#limits) : stored;
			const bytes = this.#limits.retain === "tail" ? utf8ByteLength(text) : this.#storedBytes;
			this.#chunks = text === "" ? [] : [{ text, bytes, newlines: countNewlines(text) }];
			this.#storedBytes = bytes;
			this.#storedNewlines = this.#chunks[0]?.newlines ?? 0;
		}
		return {
			text: sanitizeOutput(kept.text),
			droppedBytes: this.#totalBytes - kept.bytes,
			droppedLines: lines(this.#totalNewlines, this.#endsWithNewline) - keptLines,
		};
	}
}

/**
 * `text` 中字节数多于 `maxBytes` 或换行数多于 `maxLines` 的最短后缀，否则为整个 `text`。任何以此后缀结尾的
 * 文本，其后无论接什么，其 tail 窗口都与 `text` 接上该内容后的 tail 窗口相同。
 */
function tailMargin(text: string, limits: OutputLimits): string {
	const bytes = encoder.encode(text);
	const byteStart = bytes.length > limits.maxBytes ? characterEnd(bytes, bytes.length - limits.maxBytes - 1) : 0;
	let lineStart = 0;
	let newlines = 0;
	for (let index = bytes.lastIndexOf(NEWLINE); index !== -1; index = bytes.lastIndexOf(NEWLINE, index - 1)) {
		if (++newlines > limits.maxLines) {
			lineStart = index;
			break;
		}
		if (index === 0) break;
	}
	const start = Math.max(byteStart, lineStart);
	return start === 0 ? text : decoder.decode(bytes.subarray(start));
}

/** 带有 `newlines` 个换行的文本行数；末尾未终结的一行也计入。 */
function lines(newlines: number, terminated: boolean): number {
	return newlines + (terminated ? 0 : 1);
}

function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
	return count;
}

/** 每次进度提交还会换得一段与写入量成正比的停顿。 */
export const PROGRESS_BYTES_PER_SECOND = 100 * 1024;

/**
 * 自适应进度提交：空闲期之后的第一个变更立即提交；此后每次提交都会把下一次推迟至少 `minIntervalMs`，并按
 * 其写入量以 100 KiB/s 追加延迟。同时至多有一个提交在途中；期间发生的变更会合并进下一次提交。
 */
export class Progress {
	readonly #write: () => Promise<number>;
	readonly #onError: (error: unknown) => void;
	readonly #minIntervalMs: number;
	#waiters: PromiseWithResolvers<void>[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inFlight: Promise<void> | undefined;
	#nextAt = 0;
	#dirty = false;
	#stopped = false;

	constructor(write: () => Promise<number>, onError: (error: unknown) => void, minIntervalMs: number) {
		this.#write = write;
		this.#onError = onError;
		this.#minIntervalMs = minIntervalMs;
	}

	/** 排定一次提交。 */
	mark(): void {
		this.#dirty = true;
		this.#schedule();
	}

	/** 排定一次提交；promise 会伴随包含了本次变更的那次提交落定。 */
	markAndWait(): Promise<void> {
		const waiter = Promise.withResolvers<void>();
		this.#waiters.push(waiter);
		this.mark();
		return waiter.promise;
	}

	/** 停止提交并等待在途提交；返回最后那次提交需要落定的 waiters。 */
	async stop(): Promise<PromiseWithResolvers<void>[]> {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#inFlight;
		return this.#waiters.splice(0);
	}

	#schedule(): void {
		if (this.#stopped || this.#timer !== undefined || this.#inFlight !== undefined) return;
		const wait = this.#nextAt - Date.now();
		if (wait <= 0) this.#flush();
		else
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#flush();
			}, wait);
	}

	#flush(): void {
		if (this.#stopped || !this.#dirty) return;
		this.#dirty = false;
		const waiters = this.#waiters.splice(0);
		const started = Date.now();
		this.#inFlight = this.#write()
			.then(
				(bytes) => {
					this.#nextAt = started + Math.max(this.#minIntervalMs, (bytes * 1000) / PROGRESS_BYTES_PER_SECOND);
					for (const waiter of waiters) waiter.resolve();
				},
				(error: unknown) => {
					this.#nextAt = started + this.#minIntervalMs;
					for (const waiter of waiters) waiter.reject(error);
					this.#onError(error);
				},
			)
			.finally(() => {
				this.#inFlight = undefined;
				if (this.#dirty) this.#schedule();
			});
	}
}
