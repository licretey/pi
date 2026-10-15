/**
 * 在沙箱中运行单个 codemode 脚本。此逻辑从 tool.ts 拆出，并通过 execute.lazy.ts 加载，
 * 使沙箱运行时仅在脚本运行时才加载。
 */

import type { AgentTool, AgentToolCallOutcome, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	AnyModel,
	ClassifierContext,
	ImageContent,
	ImagesContext,
	ModelType,
	ModelTypeMap,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai";
import {
	type CodemodeOutputItem,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSWasm,
	parseCodemodeSource,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
import { getCodemodeWorkerSpecifier, getQuickJSWasmPath } from "../../config.ts";
import type { ExtensionToolContext, ToolNamespace } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { writeOutputFile } from "../../utils/output-files.ts";
import { Bm25Ranker, createToolSearchDocument, DEFAULT_TOOL_SEARCH_LIMIT } from "../tool-search/tool.ts";
import {
	CODEMODE_DOCS_PATH,
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeModelRuntime,
	type CodemodeNestedCall,
	type CodemodeStoreEntryData,
	type CodemodeToolDetails,
	type CodemodeToolInput,
	type CodemodeToolOptions,
	getCodemodeCallableTools,
	toCodemodeDeclaration,
} from "./tool.ts";

const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
/** 单个脚本可同时执行的 `models.classify()` 和 `models.generateImages()` 调用数；超过上限的调用（例如 `Promise.all` 中的其余项）会排队等待。 */
const MAX_CONCURRENT_MODEL_CALLS = 4;
/**
 * QuickJS 虚拟机的堆内存上限。工作线程与 pi 共享进程，因此不设上限时，失控脚本可能占满 wasm32 的
 * 4 GiB 地址空间并导致会话退出。超出限制时，脚本内部会抛出 `InternalError: out of memory`。
 */
const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const MODEL_TYPES: ReadonlySet<string> = new Set<ModelType>(["chat", "image", "classifier"]);

function truncateText(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function previewArgs(args: unknown): string {
	if (args === undefined) return "";
	try {
		return truncateText(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS);
	} catch {
		return "";
	}
}

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function toModelType(value: unknown): ModelType {
	if (typeof value === "string" && MODEL_TYPES.has(value)) return value as ModelType;
	throw new Error(`Unknown model type ${JSON.stringify(value)}. Use "chat", "image", or "classifier".`);
}

function toProvider(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error("provider must be a string");
	return value;
}

/** 提供给脚本的目录条目。会移除 `headers`，因为 models.json 的标头可能包含凭据。 */
function toModelInfo(model: AnyModel): Record<string, unknown> {
	const info: Record<string, unknown> = { ...model };
	delete info.headers;
	return info;
}

/** 生成英文不定冠词，例如 `an image`、`a classifier`。 */
function withArticle(word: string): string {
	return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 错误消息中的脚本值描述：`undefined`、`a string`、`an array`，或对象键（`{ prompt }`）。 */
function describeValue(value: unknown): string {
	if (value === undefined || value === null) return String(value);
	if (Array.isArray(value)) return value.length === 0 ? "an empty array" : "an array";
	if (typeof value === "object") {
		const keys = Object.keys(value);
		if (keys.length === 0) return "{}";
		return `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", ..." : ""} }`;
	}
	return typeof value === "string" ? "a string" : `a ${typeof value}`;
}

const CLASSIFIER_CONTEXT_SHAPE =
	'{ state: { ... }, images?: [{ type: "image", data: <base64>, mimeType }], questions: { <id>: { type: "choice", instructions, criteria: { <label>: <meaning> } } | { type: "score", instructions, criteria: [<lowest level>, ..., <highest level>] } | { type: "bool", instructions, criteria: { true: <meaning>, false: <meaning> } } } }';

/** 检查脚本传入的分类器上下文，使格式错误时能报告预期结构，而不是返回提供商错误。 */
function checkClassifierContext(context: unknown): ClassifierContext {
	const fail = (problem: string) =>
		new Error(
			`models.classify() ${problem}. Expected context: ${CLASSIFIER_CONTEXT_SHAPE}. See "Classify" in ${CODEMODE_DOCS_PATH}.`,
		);
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	if (!isRecord(context.state)) throw fail(`context.state must be an object, got ${describeValue(context.state)}`);
	const { images } = context;
	if (images !== undefined) {
		if (!Array.isArray(images)) throw fail(`context.images must be an array, got ${describeValue(images)}`);
		images.forEach((image: unknown, index) => {
			if (
				!isRecord(image) ||
				image.type !== "image" ||
				typeof image.data !== "string" ||
				typeof image.mimeType !== "string"
			) {
				throw fail(`context.images[${index}] must be an image block, got ${describeValue(image)}`);
			}
		});
	}
	const { questions } = context;
	if (!isRecord(questions) || Object.keys(questions).length === 0) {
		throw fail(`context.questions must map question IDs to questions, got ${describeValue(questions)}`);
	}
	const isStrings = (values: unknown[]) => values.length > 0 && values.every((value) => typeof value === "string");
	for (const [id, question] of Object.entries(questions)) {
		const at = `context.questions.${id}`;
		if (!isRecord(question)) throw fail(`${at} must be a question object, got ${describeValue(question)}`);
		if (typeof question.instructions !== "string") throw fail(`${at}.instructions must be a string`);
		const { criteria } = question;
		if (question.type === "choice") {
			if (!isRecord(criteria) || !isStrings(Object.values(criteria))) {
				throw fail(`${at} is a "choice" question, so criteria must map each label to its meaning`);
			}
		} else if (question.type === "score") {
			if (!Array.isArray(criteria) || !isStrings(criteria)) {
				throw fail(`${at} is a "score" question, so criteria must list the levels as strings, lowest first`);
			}
		} else if (question.type === "bool") {
			if (!isRecord(criteria) || typeof criteria.true !== "string" || typeof criteria.false !== "string") {
				throw fail(`${at} is a "bool" question, so criteria must be { true: string, false: string }`);
			}
		} else {
			throw fail(`${at}.type must be "choice", "score", or "bool", got ${JSON.stringify(question.type)}`);
		}
	}
	return context as unknown as ClassifierContext;
}

/** 检查脚本传入的图像上下文；例如 `{ prompt }` 这类错误格式会收到预期结构说明。 */
function checkImagesContext(context: unknown): ImagesContext {
	const fail = (problem: string) =>
		new Error(
			`models.generateImages() ${problem}. Expected context: { input: [{ type: "text", text: <prompt> }, ...optional { type: "image", data: <base64>, mimeType } references] }. See "Generate images" in ${CODEMODE_DOCS_PATH}.`,
		);
	if (!isRecord(context)) throw fail(`expects a context object as its second argument, got ${describeValue(context)}`);
	const { input } = context;
	if (!Array.isArray(input) || input.length === 0) {
		throw fail(`context.input must be a non-empty array of blocks, got ${describeValue(input)}`);
	}
	input.forEach((block: unknown, index) => {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return;
		if (
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		) {
			return;
		}
		throw fail(`context.input[${index}] must be a text or image block, got ${describeValue(block)}`);
	});
	return context as unknown as ImagesContext;
}

/** 嵌套调用行会报告的 `ClassifierResult` 和 `AssistantImages` 字段。 */
interface ModelCallResult {
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	usage?: Usage;
}

/** 按调用顺序执行任务，同时运行的调用数不超过 `limit`。 */
function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (run) => {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			return await run();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

function isStoreEntryData(data: unknown): data is CodemodeStoreEntryData {
	if (typeof data !== "object" || data === null) return false;
	const { set, delete: deleted } = data as Partial<CodemodeStoreEntryData>;
	return (
		typeof set === "object" &&
		set !== null &&
		Array.isArray(deleted) &&
		deleted.every((key: unknown) => typeof key === "string")
	);
}

/** `load()` 可读取的值：从根节点开始应用当前分支中的 `codemode-store` 条目后得到的结果。 */
export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	const store = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE || !isStoreEntryData(entry.data)) {
			continue;
		}
		for (const key of entry.data.delete) store.delete(key);
		for (const [key, value] of Object.entries(entry.data.set)) store.set(key, value);
	}
	return Object.fromEntries(store);
}

/** 脚本输出的默认 token 预算。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
/** 估算时每个 token 对应的字符数。 */
const CHARS_PER_TOKEN = 4;

/** 与脚本的 `text()` 一样：字符串原样返回，其他值转换为紧凑 JSON。 */
function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

/**
 * 格式化脚本输出，便于模型区分各项：提供商可能会用换行符连接相邻文本块，也可能直接拼接。
 * 存在多个文本项（`text()` 或返回值）时，每项前面都会添加 `==> text N/M <==` 行。
 * `console.*` 输出会统一放在其他输出之后的一个 `<console_output>` 块中。
 */
function formatOutput(output: readonly CodemodeOutputItem[]): (TextContent | ImageContent)[] {
	const total = output.filter((item) => item.type === "text" && !item.console).length;
	const items: (TextContent | ImageContent)[] = [];
	const consoleLines: string[] = [];
	let index = 0;
	for (const item of output) {
		if (item.type === "image") {
			items.push(item);
		} else if (item.console) {
			consoleLines.push(item.text);
		} else {
			index++;
			items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
		}
	}
	if (consoleLines.length > 0) {
		items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
	}
	return items;
}

/** 将相邻文本项合并为一项，每部分各占一行。 */
function joinAdjacentText(items: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	const joined: (TextContent | ImageContent)[] = [];
	for (const item of items) {
		const last = joined.at(-1);
		if (item.type === "text" && last?.type === "text") {
			const separator = last.text === "" || last.text.endsWith("\n") ? "" : "\n";
			joined[joined.length - 1] = { type: "text", text: `${last.text}${separator}${item.text}` };
		} else {
			joined.push(item);
		}
	}
	return joined;
}

function formatCallSummary(calls: readonly CodemodeNestedCall[]): string {
	if (calls.length === 0) return "No tool calls were made.";
	return `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
}

function formatError(result: Extract<CodemodeResult, { ok: false }>, calls: readonly CodemodeNestedCall[]): string {
	const { error } = result;
	const head =
		error.kind === "script"
			? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	return `${head}\n\n${formatCallSummary(calls)}`;
}

/** 与 bash 处理截断输出的方式类似，将完整文本输出写入临时文件。 */
async function spillOutput(text: string): Promise<{ path: string } | { error: string }> {
	try {
		return { path: await writeOutputFile("pi-codemode", ".txt", text) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** `image()` 接受的图像类型对应的文件扩展名。必须列出沙箱 `image()` 能识别的所有类型。 */
const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

/**
 * 将每张图像保存到临时文件，并在图像前添加包含文件路径的文本项。模型可以看到图像，但无法通过其他方式
 * 访问其字节数据：脚本不能写文件，`write` 也只接受文本。重复显示的同一张图像只保存一次。
 */
async function saveImages(items: (TextContent | ImageContent)[]): Promise<(TextContent | ImageContent)[]> {
	const labels = new Map<string, Promise<string>>();
	const label = async ({ data, mimeType }: ImageContent): Promise<string> => {
		const bytes = Buffer.from(data, "base64");
		const kind = `${mimeType}, ${formatSize(bytes.length)}`;
		const extension = IMAGE_EXTENSIONS[mimeType];
		if (!extension) throw new Error(`No file extension for image type ${mimeType}`);
		// 写入失败（例如磁盘已满或临时目录不可写）时，不能丢弃已执行工具调用的脚本结果，
		// 因此会将失败信息加入图像说明。
		try {
			const path = await writeOutputFile("pi-codemode", extension, bytes);
			return `[Image saved to ${path} (${kind})]`;
		} catch (error) {
			return `[Image (${kind}) could not be saved: ${error instanceof Error ? error.message : String(error)}]`;
		}
	};
	const result = await Promise.all(
		items.map(async (item): Promise<(TextContent | ImageContent)[]> => {
			if (item.type !== "image") return [item];
			let pending = labels.get(item.data);
			if (!pending) {
				pending = label(item);
				labels.set(item.data, pending);
			}
			return [{ type: "text", text: await pending }, item];
		}),
	);
	return result.flat();
}

/**
 * 应用 token 预算：合并文本超出预算时，将所有文本项合并为一项，只保留文本首尾部分，图像放在其后。
 * 完整文本会写入临时文件。
 */
async function truncateOutput(
	items: (TextContent | ImageContent)[],
	maxTokens: number,
): Promise<{ items: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const texts = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text);
	const combined = texts.join("\n");
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (texts.length === 0 || combined.length <= budget) return { items };
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	const head = combined.slice(0, headChars);
	const tail = tailChars > 0 ? combined.slice(-tailChars) : "";
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${head}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tail}`;
	const spilled = await spillOutput(combined);
	text +=
		"path" in spilled
			? `\n\n[Full output: ${spilled.path} (read with offset/limit)]`
			: `\n\n[Could not save the full output: ${spilled.error}]`;
	return {
		items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
		...("path" in spilled ? { fullOutputPath: spilled.path } : {}),
	};
}

/**
 * 脚本收到的嵌套调用结果：声明了 `outputSchema` 的工具返回其 `structuredContent`，包括包含该字段的
 * 错误结果（例如带有 `isError` 的 MCP 结果）；其他工具返回文本内容。其他失败会以工具错误文本拒绝。
 */
function toScriptValue(tool: AgentTool<any>, outcome: AgentToolCallOutcome): unknown {
	const { result } = outcome;
	if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
	const text = textOf(result);
	if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
	return text;
}

/**
 * 运行单个脚本。没有会话上下文时（例如普通 Agent 或直接调用），脚本不能调用工具，
 * `store()` 初始为空，写入也会被丢弃。
 */
export async function executeCodemode(
	toolCallId: string,
	input: CodemodeToolInput,
	signal: AbortSignal | undefined,
	onUpdate: ((result: AgentToolResult<CodemodeToolDetails>) => void) | undefined,
	ctx: ExtensionToolContext | undefined,
	options: CodemodeToolOptions = {},
): Promise<AgentToolResult<CodemodeToolDetails>> {
	const startedAt = performance.now();
	const { code, options: sourceOptions } = parseCodemodeSource(input.code);
	const calls: CodemodeNestedCall[] = [];
	// 脚本 `models.*` 调用的用量。嵌套工具调用的用量由会话报告。
	let modelUsage: Usage | undefined;
	// `models.generateImages()` 返回的图像数，用于发现脚本生成了图像却从未展示的情况。
	let generatedImages = 0;
	const addGeneratedImages = (count: number) => {
		generatedImages += count;
	};
	const addModelUsage = (usage: Usage) => {
		modelUsage = modelUsage ? combineUsage(modelUsage, usage) : usage;
	};

	const snapshot = (): CodemodeToolDetails => ({ calls: calls.map((call) => ({ ...call })) });
	const publish = () => onUpdate?.({ content: [], details: snapshot() });

	const callable = ctx ? getCodemodeCallableTools(ctx.tools) : [];
	// ALL_TOOLS 条目包含工具声明。
	const guidelines = options.getToolGuidelines?.();
	const samples = new Map(
		callable.map((tool) => [tool.name, renderToolSample(toCodemodeDeclaration(tool, guidelines?.get(tool.name)))]),
	);
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		name: tool.name,
		description: samples.get(tool.name),
		execute: async (args, { signal: callSignal }) => {
			const record: CodemodeNestedCall = {
				id: `${toolCallId}/?`,
				name: tool.name,
				args: previewArgs(args),
				status: "running",
			};
			calls.push(record);
			publish();
			const callStartedAt = performance.now();
			// 只有 ctx.tools 中的工具可调用，因此此处 ctx 必定已设置。
			if (!ctx) throw new Error("Tool calls need a session");
			const outcome = await ctx.executeTool(tool.name, args, { signal: callSignal });
			record.id = outcome.toolCall.id;
			record.durationMs = performance.now() - callStartedAt;
			if (outcome.isError) {
				record.status = callSignal.aborted ? "cancelled" : "error";
				record.error = truncateText(textOf(outcome.result) || `Tool "${tool.name}" failed`, ERROR_PREVIEW_CHARS);
			} else {
				record.status = "ok";
			}
			publish();
			return toScriptValue(tool, outcome);
		},
	}));

	const sandbox = new CodemodeSandbox({
		tools: sandboxTools,
		globals: [
			...createDiscoveryGlobals(callable, samples, options),
			...(options.models && ctx
				? createModelGlobals(ctx.modelRegistry, toolCallId, calls, publish, addModelUsage, addGeneratedImages)
				: []),
		],
		timeoutMs: sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY,
		memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES,
		wasm: loadQuickJSWasm(getQuickJSWasmPath()),
		workerUrl: getCodemodeWorkerSpecifier(),
	});

	let result: CodemodeResult;
	try {
		const store = ctx ? readCodemodeStore(ctx.sessionManager.getBranch()) : {};
		result = await sandbox.execute(code, { signal, store });
	} finally {
		await sandbox.close();
	}
	// 仍标记为运行中的调用，是因脚本结束、超时或中止而被截断的。
	for (const call of calls) {
		if (call.status === "running") call.status = "cancelled";
	}

	const scriptOutput = [...result.output];
	if (result.ok) {
		const { set, delete: deleted } = result.storeWrites;
		if (Object.keys(set).length > 0 || deleted.length > 0) {
			options.appendEntry?.(CODEMODE_STORE_ENTRY_TYPE, { set, delete: deleted });
		}
		// pi 扩展：脚本返回值会像 text() 一样追加到输出中。
		if (result.value !== undefined) scriptOutput.push({ type: "text", text: valueText(result.value) });
	}
	const items = formatOutput(scriptOutput);
	if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
	if (generatedImages > 0 && !items.some((item) => item.type === "image")) {
		items.push({
			type: "text",
			text: `Note: models.generateImages() returned ${generatedImages} image${generatedImages === 1 ? "" : "s"} that the script did not show. Show each image block of result.output with image(block).`,
		});
	}

	const truncated = await truncateOutput(
		joinAdjacentText(items),
		sourceOptions.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
	);
	// 截断操作会合并文本项并将图像移到文本之后，因此每个路径都会紧邻对应图像，且不会被截断。
	const output = joinAdjacentText(await saveImages(truncated.items));
	const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
	const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
	const details = snapshot();
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	return {
		content: [{ type: "text", text: header }, ...output],
		details,
		...(modelUsage ? { usage: modelUsage } : {}),
		...(result.ok ? {} : { isError: true }),
	};
}

/**
 * 判断 `query` 是否指向该命名空间：可以是命名空间名称、脚本标识符（`mcp__dev-radius` 会变为
 * `mcp__dev_radius`），也可以是两种形式中最后一个 `__` 后面的部分（`dev-radius`、`dev_radius`）。
 */
function isNamespaceName(namespace: string, query: string): boolean {
	const id = toCodemodeIdentifier(namespace);
	const queryId = toCodemodeIdentifier(query);
	const suffix = (name: string) => (name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : undefined);
	return namespace === query || id === queryId || suffix(namespace) === query || suffix(id) === queryId;
}

/**
 * 为 `searchTools()`、`describeTool()` 和 `describeNamespace()` 提供功能：对脚本的嵌套工具及其命名空间
 * 进行排序搜索和查找。
 */
function createDiscoveryGlobals(
	tools: readonly AgentTool<any>[],
	samples: ReadonlyMap<string, string>,
	options: CodemodeToolOptions,
): CodemodeTool[] {
	const ranker = new Bm25Ranker();
	const entry = (name: string) => ({ name: toCodemodeIdentifier(name), description: samples.get(name) ?? "" });
	return [
		{
			name: "searchTools",
			spread: true,
			execute: (args) => {
				const [query, searchOptions] = args as [unknown, { limit?: unknown; namespace?: unknown } | undefined];
				if (typeof query !== "string") throw new Error("searchTools() expects a query string");
				const limit = searchOptions?.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
					throw new Error("searchTools() limit must be a positive integer");
				}
				const namespace = searchOptions?.namespace;
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
					throw new Error("searchTools() namespace must be a string");
				}
				const documents = tools.flatMap((tool) => {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (namespace && (!toolNamespace || !isNamespaceName(toolNamespace.name, namespace))) return [];
					return [createToolSearchDocument(tool, toolNamespace)];
				});
				return ranker.rank(query, documents, limit).map((match) => entry(match.name));
			},
		},
		{
			name: "describeTool",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeTool() expects a tool name");
				const tool = tools.find(
					(candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name,
				);
				return tool ? samples.get(tool.name) : undefined;
			},
		},
		{
			name: "describeNamespace",
			spread: true,
			execute: (args) => {
				const [name] = args as unknown[];
				if (typeof name !== "string") throw new Error("describeNamespace() expects a namespace name");
				let namespace: ToolNamespace | undefined;
				const names: string[] = [];
				for (const tool of tools) {
					const toolNamespace = options.getToolNamespace?.(tool.name);
					if (!toolNamespace || !isNamespaceName(toolNamespace.name, name)) continue;
					namespace ??= toolNamespace;
					names.push(toCodemodeIdentifier(tool.name));
				}
				if (!namespace) return undefined;
				return {
					name: namespace.name,
					...(namespace.description ? { description: namespace.description } : {}),
					...(namespace.instructions ? { instructions: namespace.instructions } : {}),
					tools: names,
				};
			},
		},
	];
}

/**
 * 为脚本提供 `models.*`：即 docs/codemode.md 中记录的模型注册表方法。
 * 分类器和图像调用会显示为嵌套调用行，以便渲染器展示；其用量会传给 `addUsage`。
 * 调用行只显示模型信息，不显示提示内容或图像数据。
 */
function createModelGlobals(
	models: CodemodeModelRuntime,
	toolCallId: string,
	calls: CodemodeNestedCall[],
	publish: () => void,
	addUsage: (usage: Usage) => void,
	addGeneratedImages: (count: number) => void,
): CodemodeTool[] {
	const limit = createLimiter(MAX_CONCURRENT_MODEL_CALLS);
	let callCount = 0;

	/**
	 * 仅根据提供商和 ID 解析脚本请求的模型，检查上下文，然后将调用作为嵌套调用行执行。
	 * 绝不能将凭据发送到脚本指定的 baseUrl 或 headers。
	 */
	const runModelCall = async <TType extends "classifier" | "image", TContext, TResult extends ModelCallResult>(
		name: string,
		type: TType,
		[model, context]: unknown[],
		checkContext: (context: unknown) => TContext,
		run: (resolved: ModelTypeMap[TType], context: TContext) => Promise<TResult>,
	): Promise<TResult> => {
		const listHint = `List the ${type} models you can use with models.getAvailableOfType("${type}").`;
		if (!isRecord(model) || typeof model.provider !== "string" || typeof model.id !== "string") {
			// undefined 到达此处时会变成 null：展开参数以 JSON 数组形式跨越沙箱边界。
			const undefinedHint =
				model === undefined || model === null
					? " models.getModelOfType() returns undefined for an unknown provider or id."
					: "";
			throw new Error(
				`${name}() expects ${withArticle(type)} model as its first argument, got ${describeValue(model)}.${undefinedHint} ${listHint}`,
			);
		}
		const { provider, id } = model;
		const ref = `${provider}/${id}`;
		const resolved = models.getModelOfType(type, provider, id);
		if (!resolved) {
			const actualType = [...MODEL_TYPES].find(
				(other) => other !== type && models.getModelOfType(other as ModelType, provider, id) !== undefined,
			);
			throw new Error(
				actualType
					? `"${ref}" is ${withArticle(actualType)} model, not ${withArticle(type)} model. ${listHint}`
					: `Unknown ${type} model "${ref}". ${listHint}`,
			);
		}
		const checked = checkContext(context);

		const record: CodemodeNestedCall = {
			id: `${toolCallId}/${name}/${++callCount}`,
			name,
			args: `${resolved.provider}/${resolved.id}`,
			status: "running",
		};
		calls.push(record);
		publish();
		const startedAt = performance.now();
		const result = await limit(() => run(resolved, checked));
		record.durationMs = performance.now() - startedAt;
		record.status = result.stopReason === "stop" ? "ok" : result.stopReason === "aborted" ? "cancelled" : "error";
		if (result.errorMessage) record.error = truncateText(result.errorMessage, ERROR_PREVIEW_CHARS);
		if (result.usage) {
			record.cost = result.usage.cost.total;
			addUsage(result.usage);
		}
		publish();
		return result;
	};
	const implementations: Record<string, CodemodeTool["execute"]> = {
		"models.getModelsOfType": (args) => {
			const [type, provider] = args as unknown[];
			return models.getModelsOfType(toModelType(type), toProvider(provider)).map(toModelInfo);
		},
		"models.getAvailableOfType": async (args, { signal }) => {
			const [type, provider] = args as unknown[];
			const available = await models.getAvailableOfType(toModelType(type), toProvider(provider), { signal });
			return available.map(toModelInfo);
		},
		"models.getModelOfType": (args) => {
			const [type, provider, id] = args as unknown[];
			if (typeof provider !== "string" || typeof id !== "string") {
				throw new Error(
					`models.getModelOfType(type, provider, id) expects three strings, got (${(args as unknown[]).map(describeValue).join(", ")}). The provider and the id are separate arguments, for example models.getModelOfType("classifier", "typesafe", "jev-latest").`,
				);
			}
			const model = models.getModelOfType(toModelType(type), provider, id);
			return model === undefined ? undefined : toModelInfo(model);
		},
		"models.classify": (args, { signal }) =>
			runModelCall("models.classify", "classifier", args as unknown[], checkClassifierContext, (resolved, context) =>
				models.classify(resolved, context, { signal }),
			),
		"models.generateImages": (args, { signal }) =>
			runModelCall(
				"models.generateImages",
				"image",
				args as unknown[],
				checkImagesContext,
				async (resolved, context) => {
					const result = await models.generateImages(resolved, context, { signal });
					addGeneratedImages(result.output.filter((block) => block.type === "image").length);
					return result;
				},
			),
	};
	return Object.entries(implementations).map(([name, execute]) => ({ name, spread: true, execute }));
}
