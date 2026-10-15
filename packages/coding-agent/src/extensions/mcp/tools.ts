/**
 * 把 MCP 工具适配为 pi 工具定义。
 *
 * 结果映射到 pi 面向模型的内容（文本与图片）。超过 20KB 的文本像 Codex 一样保留开头与
 * 结尾、挖去中段，并将全文保存到模型可读的临时文件。图片之外的二进制资源同样保存到临时文件，资源链接则
 * 指向 `read_mcp_resource` 工具。Codemode 脚本收到不含 `_meta` 的完整 `CallToolResult`
 * （server 原样发送的 `content` blocks、`structuredContent`、`isError`），绝不截断：它就是
 * 工具的 `structuredContent`，且每个 MCP 工具都声明了 `CallToolResult` 输出 schema。MCP
 * 错误（`isError`）对模型是错误结果，但脚本仍会 resolve 到该结果。
 */

import { createHash } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import {
	type CallToolResult,
	type ContentBlock,
	type McpRequestOptions,
	type Tool as McpTool,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type {
	ToolAnnotations,
	ToolDefinition,
	ToolExposure,
	ToolNamespace,
	ToolRenderers,
} from "../../core/extensions/types.ts";
import { READ_MCP_RESOURCE_TOOL } from "../../core/mcp-servers.ts";
import { formatToolCallWithArgs, getTextOutput, replaceTabs } from "../../core/tools/render-utils.ts";
import { formatSize, truncateMiddle } from "../../core/tools/truncate.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { VisualLinePreview } from "../../modes/interactive/components/visual-truncate.ts";
import { writeOutputFile } from "../../utils/output-files.ts";
import type { McpExposure } from "./config.ts";

/**
 * MCP exposure 对应的工具 exposure。`codemode` 与 `deferred` 都不把工具放进 codemode
 * 描述；区别只在于 MCP extension 激活哪个工具来触达它们。
 */
export function toToolExposure(exposure: McpExposure): ToolExposure {
	return exposure === "codemode" ? "deferred" : exposure;
}

/** provider 的工具名限制为 `[A-Za-z0-9_-]` 的 64 个字符。 */
const MAX_TOOL_NAME_LENGTH = 64;
/** MCP 结果中面向模型的文本超过此值就在中间截断。 */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
/** 输出展开之前显示的结果行数（视觉折行后）。 */
const OUTPUT_PREVIEW_LINES = 5;
/** 读取资源链接所指资源的工具。 */
export { READ_MCP_RESOURCE_TOOL };

export interface McpToolDetails {
	server: string;
	tool: string;
	/** 面向模型的文本被截断后，保存完整文本输出的临时文件。 */
	fullOutputPath?: string;
}

/**
 * 保存被截断结果的完整文本或某个二进制资源，并返回文件路径。
 * `extension` 含点号，例如 `.txt`。
 */
export type McpOutputSaver = (data: string | Uint8Array, extension: string) => Promise<string>;

export function saveToTempFile(data: string | Uint8Array, extension: string): Promise<string> {
	return writeOutputFile("pi-mcp", extension, data);
}

export interface McpToolCaller {
	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult>;
}

/**
 * `mcp__<server>__<tool>`，经过净化，过长时追加 hash 后缀缩短。与 Codex 相同，
 * 除了 `[A-Za-z0-9_]` 之外的一切字符都变成 `_`，因此该名称同时也是 codemode 脚本
 * 调用它所用的标识符。`isTaken` 报告被另一个 MCP 工具占用的名称：净化可能把两个工具
 * 映射到同一个名字（`a-b` 与 `a_b`），此时会追加 hash 后缀。
 */
export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * 每个 MCP 工具的输出 schema：即脚本收到的 `CallToolResult`，其中工具自身的输出
 * schema 作为 `structuredContent`。Codemode 检测该形状以渲染 `CallToolResult<T>`
 * 声明。
 */
export function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): TSchema {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: { type: "object" } },
			...(structuredContentSchema ? { structuredContent: structuredContentSchema } : {}),
			isError: { type: "boolean" },
			_meta: { type: "object" },
		},
		required: ["content"],
	} as unknown as TSchema;
}

/**
 * 让面向模型的文本保持在 {@link MCP_OUTPUT_MAX_BYTES} 以内。更长的文本会变成一个按
 * Codex 截断格式组织的文本块，后面跟着保存完整文本的文件路径；图片跟随其后。
 */
export async function limitMcpContent(
	content: (TextContent | ImageContent)[],
	saveOutput: McpOutputSaver = saveToTempFile,
): Promise<{ content: (TextContent | ImageContent)[]; fullOutputPath?: string }> {
	const combined = textOf(content);
	const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
	if (!truncation.truncated) return { content };
	let fullOutputPath: string | undefined;
	let where: string;
	try {
		fullOutputPath = await saveOutput(combined, ".txt");
		where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
	} catch (error) {
		where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
	}
	const tokens = Math.ceil(truncation.totalBytes / 4);
	const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`;
	return {
		content: [{ type: "text", text }, ...content.filter((block) => block.type === "image")],
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

export interface ConvertMcpResultOptions {
	/** 保存被截断的文本与二进制资源。默认：写入临时文件。 */
	saveOutput?: McpOutputSaver;
	/** server 的资源能否用 `read_mcp_resource` 读取（资源链接随即指向该工具）。 */
	readableResources?: boolean;
}

/** 保存后的二进制资源的文件扩展名：取其 URI 的结尾，否则为 `.bin`。 */
function extensionOf(uri: string): string {
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

/** 这些类型的 blob 按文本显示。 */
function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const type = mimeType.split(";", 1)[0].trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

/** `server` 结果中单个 block 面向模型的内容。 */
async function blockToContent(
	server: string,
	block: ContentBlock,
	options: ConvertMcpResultOptions,
): Promise<(TextContent | ImageContent)[]> {
	if (block.type === "resource_link") {
		const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
		const read = options.readableResources ? `. Read it with ${READ_MCP_RESOURCE_TOOL} (server "${server}")` : "";
		const description = block.description ? `: ${block.description}` : "";
		return [
			{
				type: "text",
				text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}${read}]`,
			},
		];
	}
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		const { uri, mimeType, blob } = block.resource;
		const data = Buffer.from(blob, "base64");
		if (isTextMimeType(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
		const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
		try {
			const path = await (options.saveOutput ?? saveToTempFile)(data, extensionOf(uri));
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` }];
		}
	}
	return toLlmContent({ content: [block] });
}

/** `server` 各 content block 面向模型的内容，在输出上限之前。 */
export async function toModelContent(
	server: string,
	blocks: readonly ContentBlock[],
	options: ConvertMcpResultOptions = {},
): Promise<(TextContent | ImageContent)[]> {
	return (await Promise.all(blocks.map((block) => blockToContent(server, block, options)))).flat();
}

/** 转换一个 MCP 结果。`isError` 结果会变成保留结构化结果的错误结果。 */
export async function convertMcpResult(
	server: string,
	tool: string,
	result: CallToolResult,
	options: ConvertMcpResultOptions = {},
): Promise<AgentToolResult<McpToolDetails>> {
	// 没有 content blocks 时，toLlmContent 回退为把结构化内容当作 JSON。
	const converted: (TextContent | ImageContent)[] =
		result.content.length > 0 ? await toModelContent(server, result.content, options) : toLlmContent(result);
	if (result.isError && textOf(converted) === "") {
		converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
	}
	const { content, fullOutputPath } = await limitMcpContent(converted, options.saveOutput);
	const { _meta: _ignored, ...scriptResult } = result;
	return {
		content,
		details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
		structuredContent: scriptResult as unknown as JsonValue,
		...(result.isError ? { isError: true } : {}),
	};
}

/**
 * 工具输入 schema 必须是对象。MCP server 可能省略 `type`，而有的 provider 会拒绝
 * 没有 `properties` 的对象 schema。
 */
function toParameters(schema: Record<string, unknown>): TSchema {
	return {
		...schema,
		type: schema.type ?? "object",
		...(schema.properties === undefined ? { properties: {} } : {}),
	} as unknown as TSchema;
}

const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** MCP 工具 annotations 中的布尔提示（hints），一个都没有时为 undefined。 */
function toToolAnnotations(tool: McpTool): ToolAnnotations | undefined {
	const annotations: ToolAnnotations = {};
	for (const hint of ANNOTATION_HINTS) {
		const value = tool.annotations?.[hint];
		if (typeof value === "boolean") annotations[hint] = value;
	}
	return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export function createMcpToolDefinition(options: {
	server: string;
	tool: McpTool;
	name: string;
	exposure: McpExposure;
	namespace: ToolNamespace;
	timeoutMs: number;
	getClient: () => Promise<McpToolCaller>;
	/** `read_mcp_resource` 能否读取该 server 的资源。 */
	readableResources?: () => boolean;
}): ToolDefinition<TSchema, McpToolDetails> {
	const { server, tool } = options;
	const title = tool.title ?? tool.annotations?.title;
	const annotations = toToolAnnotations(tool);
	const label = `${server}/${tool.name}`;
	return {
		name: options.name,
		label,
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
		parameters: toParameters(tool.inputSchema),
		outputSchema: createMcpResultSchema(tool.outputSchema),
		exposure: toToolExposure(options.exposure),
		namespace: options.namespace,
		...(annotations ? { annotations } : {}),
		...createMcpToolRenderers(label),
		async execute(_toolCallId, params, signal, onUpdate) {
			const client = await options.getClient();
			const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
				signal,
				timeoutMs: options.timeoutMs,
				onProgress: (progress) => {
					const total = progress.total === undefined ? "" : `/${progress.total}`;
					const text = progress.message ?? `Progress ${progress.progress}${total}`;
					onUpdate?.({ content: [{ type: "text", text }], details: { server, tool: tool.name } });
				},
			});
			return convertMcpResult(server, tool.name, result, { readableResources: options.readableResources?.() });
		},
	};
}

/** MCP 工具调用的 renderer，标签为 `server/tool`；也在工具注册之前使用。 */
export function createMcpToolRenderers(label: string): ToolRenderers {
	return {
		renderCall(args, theme, context) {
			const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText(formatToolCallWithArgs(label, args, theme, context.expanded));
			return component;
		},
		renderResult(result, options, theme, context) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			const output = getTextOutput(result, context.showImages).trim();
			if (!output) return component;
			const color = context.isError ? "error" : "toolOutput";
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			component.addChild(new Spacer(1));
			if (options.expanded) {
				component.addChild(new Text(styled, 0, 0));
			} else {
				// 限制的是折行后的视觉行，而非逻辑行：MCP 结果常常是一整条长 JSON 行。
				component.addChild(
					new VisualLinePreview({
						text: styled,
						maxVisualLines: OUTPUT_PREVIEW_LINES,
						keep: "start",
						formatHint: (hidden) =>
							`${theme.fg("muted", `... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					}),
				);
				const fullOutputPath = (result.details as McpToolDetails | undefined)?.fullOutputPath;
				if (fullOutputPath) component.addChild(new Text(theme.fg("muted", `Full output: ${fullOutputPath}`), 0, 0));
			}
			return component;
		},
	};
}
