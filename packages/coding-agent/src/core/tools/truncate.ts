/**
 * 工具输出共用的截断工具函数。
 *
 * 截断受两个相互独立的限制约束，先达到哪个限制就按哪个限制截断：
 * - 行数限制（默认 2000 行）
 * - 字节数限制（默认 50 KB）
 *
 * 不会返回不完整的行（Bash 尾部截断的特殊情况除外）。
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // grep 匹配行允许的最大字符数。

export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 触发的限制："lines"、"bytes"；未截断时为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 截断结果中的完整行数 */
	outputLines: number;
	/** 截断结果的字节数 */
	outputBytes: number;
	/** 最后一行是否被部分截断（仅尾部截断的特殊情况适用） */
	lastLinePartial: boolean;
	/** 第一行是否超出字节数限制（适用于头部截断） */
	firstLineExceedsLimit: boolean;
	/** 本次应用的最大行数限制 */
	maxLines: number;
	/** 本次应用的最大字节数限制 */
	maxBytes: number;
}

export interface TruncationOptions {
	/** 最大行数（默认：2000） */
	maxLines?: number;
	/** 最大字节数（默认：50 KB） */
	maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

/**
 * 将字节数格式化为易读的大小。
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
 * 从内容开头截断（保留前 N 行/字节）。
 * 适用于读取文件时需要查看开头内容的场景。
 *
 * 不会返回不完整的行。如果第一行超出字节数限制，
 * 则返回空内容，并将 firstLineExceedsLimit 设为 true。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 检查是否无需截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
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

	// 检查第一行是否单独就超出字节数限制
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
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

	// 收集限制范围内的完整行
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // 除首行外，每行还需计入 1 个换行符字节。

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 检查是否因达到行数限制而退出
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

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

/**
 * 从内容末尾截断（保留最后 N 行/字节）。
 * 适用于查看 Bash 输出末尾的场景（例如错误和最终结果）。
 *
 * 如果原始内容的最后一行超出字节数限制，返回结果的首行可能不完整。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 检查是否无需截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
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

	// 从末尾向前处理
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // 除首行外，每行还需计入 1 个换行符字节。

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 特殊情况：尚未添加任何行，但当前行已超出 maxBytes；
			// 此时截取该行末尾的部分内容。
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// 检查是否因达到行数限制而退出
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 从字符串末尾截断，使其不超过指定字节数。
 * 正确处理多字节 UTF-8 字符。
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// 从末尾开始，向前回退 maxBytes 个字节。
	let start = buf.length - maxBytes;

	// 找到有效的 UTF-8 边界（字符起始位置）。
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/**
 * 将单行截断到最多指定字符数，并添加 [truncated] 后缀。
 * 用于 grep 匹配结果的行。
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

export interface MiddleTruncationResult {
	/** 内容的开头和结尾，中间以 `…N chars truncated…` 标记省略部分。 */
	content: string;
	truncated: boolean;
	/** 被省略的字符数。 */
	removedChars: number;
	totalBytes: number;
	totalLines: number;
}

/**
 * 分别保留 `content` 开头和结尾各约 `maxBytes` 的一半，并将中间部分替换为
 * `…N chars truncated…` 标记，与 Codex 的工具输出处理方式相同。截断位置只会落在字符边界上。
 */
export function truncateMiddle(content: string, maxBytes: number): MiddleTruncationResult {
	const buf = Buffer.from(content, "utf-8");
	const totalLines = splitLinesForCounting(content).length;
	if (buf.length <= maxBytes) {
		return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
	}
	// UTF-8 延续字节（10xxxxxx）不是字符的起始位置。
	const isBoundary = (index: number) => index >= buf.length || (buf[index] & 0xc0) !== 0x80;
	let headEnd = Math.floor(maxBytes / 2);
	while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
	let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
	while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
	const head = buf.subarray(0, headEnd).toString("utf-8");
	const tail = buf.subarray(tailStart).toString("utf-8");
	const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString("utf-8")).length;
	return {
		content: `${head}…${removedChars} chars truncated…${tail}`,
		truncated: true,
		removedChars,
		totalBytes: buf.length,
		totalLines,
	};
}
