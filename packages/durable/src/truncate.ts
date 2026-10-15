/**
 * 工具输出共用的截断工具。
 *
 * 截断基于两个相互独立的限度——先触发的那个生效：
 * - 行数限度（默认：2000 行）
 * - 字节限度（默认：50KB）
 *
 * 永不返回半行。工具输出流的上界由 `src/harness/output.ts` 负责。
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 触发的是哪个限度："lines"、"bytes"，未截断则为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 截断输出中完整行的数量 */
	outputLines: number;
	/** 截断输出的字节数 */
	outputBytes: number;
	/** 最后一行是否被部分截断（仅尾部截断的边界情形） */
	lastLinePartial: boolean;
	/** 第一行是否超出字节限度（针对头部截断） */
	firstLineExceedsLimit: boolean;
	/** 实际应用的行数上限 */
	maxLines: number;
	/** 实际应用的字节上限 */
	maxBytes: number;
}

export interface TruncationOptions {
	/** 最大行数（默认：2000） */
	maxLines?: number;
	/** 最大字节数（默认：50KB） */
	maxBytes?: number;
}

interface RuntimeBuffer {
	byteLength(content: string, encoding: "utf8"): number;
}

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;
const nonAsciiPattern = /[^\x00-\x7f]/;

export function utf8ByteLength(content: string): number {
	if (runtimeBuffer) return runtimeBuffer.byteLength(content, "utf8");

	const firstNonAscii = content.search(nonAsciiPattern);
	if (firstNonAscii === -1) return content.length;

	let bytes = firstNonAscii;
	for (let i = firstNonAscii; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
			const next = content.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

/**
 * 把字节格式化为人类可读的大小。
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * 从头部截断内容（保留前 N 行/字节）。
 * 适合想查看文件开头的读取场景。
 *
 * 永不返回半行。若第一行超出字节限度，
 * 则返回空内容并置 firstLineExceedsLimit=true。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	return truncateHeadOf(
		content,
		{ lines: splitLinesForCounting(content).length, bytes: utf8ByteLength(content) },
		options,
	);
}

/**
 * 对由前缀及其总量已知（`lines` 按 `truncateHead` 的方式计数，忽略末尾换行）的文本求 `truncateHead`。
 * 前缀必须是完整文本，或长于 `maxBytes + 1` 个 UTF-8 字节，或包含至少 `maxLines` 个换行；
 * 此时结果等于对完整文本求 `truncateHead`。
 */
export function truncateHeadOf(
	prefix: string,
	totals: { readonly lines: number; readonly bytes: number },
	options: TruncationOptions = {},
): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = totals.bytes;
	const lines = splitLinesForCounting(prefix);
	const totalLines = totals.lines;

	// 检查是否无需截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content: prefix,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 检查仅第一行是否就已超出字节限度
	const firstLineBytes = utf8ByteLength(lines[0]);
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// 收集能放下的完整行
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // 换行符计 1 字节

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 若没有因字节触顶，只有省略了行才能证明达到行数限度；否则就是末尾换行超出了字节。
	if (truncatedBy !== "bytes") truncatedBy = outputLinesArr.length < totalLines ? "lines" : "bytes";

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}
