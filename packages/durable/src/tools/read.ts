import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "typebox";
import {
	type BinaryReader,
	type FileInfo,
	getOrThrow,
	type LineScan,
	rangeDecoder,
	startsWithBom,
} from "../env/index.ts";
import { defineTool } from "../harness/define.ts";
import { characterEnd } from "../harness/output.ts";
import type { ToolDiagnostic, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "../harness/types.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHeadOf,
	utf8ByteLength,
} from "../truncate.ts";
import { requireEnv } from "./env.ts";
import { detectSupportedImageMimeTypeOf, imageDimensions } from "./image.ts";
import {
	base64Length,
	DEFAULT_IMAGE_LIMITS,
	type ImageLimits,
	type ImageProcessor,
	INLINE_IMAGE_TYPES,
	toBase64,
} from "./image-processor.ts";
import { resolveReadToolPath } from "./path-utils.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export type ReadToolDetails = {
	/** 展示文本是如何被截断的；文本本身就是结果内容。 */
	truncation?: Omit<TruncationResult, "content">;
};

const READ_CHUNK = 64 * 1024;

/** `Array.prototype.slice` 对索引的转换：NaN 视为 0，其他值向零取整。 */
function sliceIndex(value: number): number {
	return Number.isNaN(value) ? 0 : Math.trunc(value);
}

/**
 * 文件字节区间 `[start, end)` 解码后的开头部分，解码方式与整个文件一致：要么全部，要么满足 `truncateHeadOf`
 * 所需（超过 `DEFAULT_MAX_BYTES + 1` 字节，或 `DEFAULT_MAX_LINES` 个换行）。
 */
async function readHead(
	reader: BinaryReader,
	start: number,
	end: number,
	skipBom: boolean,
	context: Context,
): Promise<string> {
	const decoder = rangeDecoder();
	let text = "";
	let newlines = 0;
	for (let position = skipBom && start === 0 ? 3 : start; position < end; ) {
		const bytes = getOrThrow(await reader.read(position, Math.min(READ_CHUNK, end - position), context));
		if (bytes.length === 0) break;
		position += bytes.length;
		const decoded = decoder.decode(bytes, { stream: true });
		text += decoded;
		for (let index = decoded.indexOf("\n"); index !== -1; index = decoded.indexOf("\n", index + 1)) newlines++;
		if (newlines >= DEFAULT_MAX_LINES || utf8ByteLength(text) > DEFAULT_MAX_BYTES + 1) return text;
	}
	return text + decoder.decode();
}

export type ReadToolOptions = {
	/** 缩放并转换图像；没有处理器时，在 `DEFAULT_IMAGE_LIMITS.maxBytes` 之内的图像原样放行。 */
	readonly images?: ImageProcessor;
};

/**
 * 读取文本文件与图像。关于截断、续读和图像处理的说明走诊断（diagnostics）；输出内容只是文件文本或一张图像，
 * 程序以 `ImageContent` 的形式获取。
 */
export function createReadTool(options: ReadToolOptions = {}): ToolRegistration<typeof readSchema, ReadToolDetails> {
	const formats = options.images === undefined ? "jpg, png, gif, webp" : "jpg, png, gif, webp, bmp";
	return defineTool({
		name: "read",
		description: `Read the contents of a file. Supports text files and images (${formats}). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		async execute(args, api, context) {
			const { path, offset, limit } = args;
			const env = requireEnv(api);
			const absolutePath = await resolveReadToolPath(env, path, context);
			const reader = getOrThrow(await env.openBinaryReader(absolutePath, undefined, context));
			try {
				// 并发写入者可能在扫描与读取之间改动文件。追加（增长中的日志）会保持扫描文本
				// 原样；图像则必须完整。其他情况下文件整体重读一次。
				for (let attempt = 0; ; attempt++) {
					const before = getOrThrow(await reader.info(context));
					const mimeType = await detectSupportedImageMimeTypeOf({
						size: before.size,
						read: async (position, length) => getOrThrow(await reader.read(position, length, context)),
					});
					const result =
						mimeType === undefined
							? await readText(reader, path, offset, limit, context)
							: await readImage(
									reader,
									before,
									path,
									mimeType,
									options.images,
									await imageModel(api, context),
									context,
								);
					const after = getOrThrow(await reader.info(context));
					const unchanged = after.size === before.size && after.mtimeMs === before.mtimeMs;
					if (unchanged || (mimeType === undefined && after.size > before.size)) return result;
					if (attempt === 1) throw new Error(`${path} changed while it was read`);
				}
			} finally {
				await reader.close(context);
			}
		},
	});
}

/**
 * 单个图像块：由 `processor` 准备；没有处理器时，若其格式可内联且符合限制则原样输出
 * （先检查大小，尺寸从头读取）；否则返回说明原因的错误结果。图像经历了什么处理以 `info` 诊断上报，
 * 因此程序拿到的是纯粹的 `ImageContent`。不支持图像输入的模型看到的是 pi-ai 的占位内容，并以诊断说明。
 */
async function readImage(
	reader: BinaryReader,
	info: FileInfo,
	path: string,
	mimeType: string,
	processor: ImageProcessor | undefined,
	{ vision, limits }: ImageModel,
	context: Context,
): Promise<ToolExecutionResult<ReadToolDetails>> {
	let image: { readonly data: string; readonly mimeType: string };
	const notes: string[] = [];
	if (processor !== undefined) {
		const bytes = getOrThrow(await reader.read(0, info.size, context));
		const prepared = await processor.prepare(bytes, mimeType, limits);
		if (prepared === undefined)
			return imageError(`${path} is an image (${mimeType}) that cannot be prepared for the model`);
		image = prepared;
		if (prepared.convertedFrom !== undefined)
			notes.push(`Converted from ${prepared.convertedFrom} to ${prepared.mimeType}.`);
		if (prepared.resized !== undefined) {
			const { from, to } = prepared.resized;
			const scale = (from.width / to.width).toFixed(2);
			notes.push(
				`Resized from ${from.width}x${from.height} to ${to.width}x${to.height}. Multiply coordinates by ${scale} to map them to the original.`,
			);
		}
	} else {
		if (!INLINE_IMAGE_TYPES.has(mimeType)) {
			return imageError(
				`${path} is an image (${mimeType}) that needs converting, and no image processor is configured`,
			);
		}
		const unshrinkable = "and no image processor is configured to shrink it";
		if (base64Length(info.size) > limits.maxBytes) {
			return imageError(
				`${path} is an image (${mimeType}) of ${formatSize(info.size)}, too large to send, ${unshrinkable}`,
			);
		}
		const bytes = getOrThrow(await reader.read(0, info.size, context));
		const size = imageDimensions(bytes, mimeType);
		if (size === undefined) return imageError(`${path} is an image (${mimeType}) whose size cannot be read`);
		if (size.width > limits.maxWidth || size.height > limits.maxHeight) {
			return imageError(
				`${path} is an image (${mimeType}) of ${size.width}x${size.height}, larger than ${limits.maxWidth}x${limits.maxHeight}, ${unshrinkable}`,
			);
		}
		image = { data: toBase64(bytes), mimeType };
	}
	if (!vision) notes.push("The current model does not support images; it sees a placeholder instead.");
	const diagnostics: ToolDiagnostic[] = [
		{ severity: "info", code: "image", message: [`Read image file [${image.mimeType}].`, ...notes].join(" ") },
	];
	return { output: [{ type: "image", data: image.data, mimeType: image.mimeType }], diagnostics };
}

/** 会话模型可接收的图像输入：是否支持图像，以及多大限制。 */
type ImageModel = { readonly vision: boolean; readonly limits: ImageLimits };

/**
 * 会话模型的图像输入：`DEFAULT_IMAGE_LIMITS` 被其 `inputLimits.images.resize` 覆盖。
 * 无法解析模型时，视为支持图像并使用默认限制。
 */
async function imageModel(api: ToolExecutionApi, context: Context): Promise<ImageModel> {
	const ref = (await api.agent(context)).model;
	const model = ref === undefined ? undefined : api.models.getModel(ref.provider, ref.modelId);
	const resize = model?.inputLimits?.images?.resize;
	return {
		vision: model?.input.includes("image") ?? true,
		limits: {
			maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
			maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
			maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
		},
	};
}

function imageError(message: string): ToolExecutionResult<ReadToolDetails> {
	return { output: [], isError: true, diagnostics: [{ severity: "error", code: "unsupported_image", message }] };
}

/**
 * 已打开文件的读取结果。它等价于用 `TextDecoder` 解码整个文件、按 `\n` 拆分、用 `truncateHead` 界定所选行，
 * 但只读取一遍扫描所需的文件量加上头部。
 */
async function readText(
	reader: BinaryReader,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
	context: Context,
) {
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	// 行的选择方式如同 `allLines.slice(startLine, endLine)`，它会对小数索引取整。
	const sliceStart = sliceIndex(startLine);
	// 一遍扫描同时求出行数与选择范围；越过最后一行的选择以最后一行收尾（与 `slice` 一致），
	// 而空选择（limit 为零或负数）会按一行扫描然后被忽略。
	// 起点越过任何文件时，从 0 扫描只为数行数；下方的 offset 检查随后照常失败。
	const scanStart = Number.isSafeInteger(sliceStart) ? sliceStart : 0;
	const requestedEnd = limit === undefined ? undefined : Math.max(scanStart + 1, sliceIndex(startLine + limit));
	const scanEnd = requestedEnd !== undefined && Number.isSafeInteger(requestedEnd) ? requestedEnd : undefined;
	const scanOf = async (endLine: number | undefined): Promise<LineScan> =>
		getOrThrow(
			await reader.scanLines({ startLine: scanStart, ...(endLine === undefined ? {} : { endLine }) }, context),
		);
	let scan = await scanOf(scanEnd);
	const totalFileLines = scan.newlines + 1;
	if (startLine >= totalFileLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
	}

	let userLimitedLines: number | undefined;
	let selectedLineCount = totalFileLines - sliceStart;
	if (limit !== undefined) {
		const endLine = Math.min(startLine + limit, totalFileLines);
		userLimitedLines = endLine - startLine;
		// `slice` 对负数终点从行尾倒数，只有行数才能确定它；为此再扫描一次。
		const relativeEnd = sliceIndex(endLine);
		const sliceEnd = relativeEnd < 0 ? Math.max(totalFileLines + relativeEnd, 0) : relativeEnd;
		selectedLineCount = Math.max(0, sliceEnd - sliceStart);
		if (selectedLineCount > 0 && relativeEnd < 0) scan = await scanOf(sliceEnd);
	}
	const empty = selectedLineCount === 0;
	// 按 `truncateHead` 的方式计数：末尾换行不增加行数，空文本没有行。
	const endsWithNewline = !empty && scan.lastLineStart === scan.end && scan.lastLineStart > scan.start;
	const totals = {
		lines: empty || scan.selectedBytes === 0 ? 0 : selectedLineCount - (endsWithNewline ? 1 : 0),
		bytes: empty ? 0 : scan.selectedBytes,
	};
	const firstBytes = getOrThrow(await reader.read(0, 3, context));
	const head = empty ? "" : await readHead(reader, scan.start, scan.end, startsWithBom(firstBytes), context);

	const { content: headText, ...truncation } = truncateHeadOf(head, totals);
	const diagnostics: ToolDiagnostic[] = [];
	let outputText = headText;
	let details: ReadToolDetails | undefined;
	if (truncation.firstLineExceedsLimit) {
		// 展示该行的开头，在字节限度的字符边界处截断。如同 `allLines[startLine]`，
		// 小数起始行不指任何行。
		const integral = Number.isInteger(startLine);
		const lineBytes = new TextEncoder().encode(integral ? (head.split("\n")[0] ?? "") : "");
		const lineSize = integral ? scan.firstLineBytes : 0;
		const end = characterEnd(lineBytes, DEFAULT_MAX_BYTES);
		outputText = new TextDecoder().decode(lineBytes.subarray(0, end));
		diagnostics.push({
			severity: "warn",
			code: "truncated",
			message: `Line ${startLineDisplay} is ${formatSize(lineSize)}, exceeds the ${formatSize(DEFAULT_MAX_BYTES)} limit; showing its first ${formatSize(end)}. Use bash: sed -n '${startLineDisplay}p' ${path} | tail -c +${end + 1}`,
		});
		details = { truncation: { ...truncation, outputBytes: end, outputLines: 1 } };
	} else if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		const limitText = truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
		diagnostics.push({
			severity: "info",
			code: "truncated",
			message: `Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}${limitText}. Use offset=${nextOffset} to continue.`,
		});
		details = { truncation };
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
		const remaining = totalFileLines - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		diagnostics.push({
			severity: "info",
			message: `${remaining} more lines in file. Use offset=${nextOffset} to continue.`,
		});
	}

	return {
		output: outputText === "" ? [] : [{ type: "text" as const, text: outputText }],
		...(details === undefined ? {} : { details }),
		diagnostics,
	};
}
