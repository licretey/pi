export interface ContentAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}

export interface TextContent {
	type: "text";
	text: string;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface AudioContent {
	type: "audio";
	data: string;
	mimeType: string;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface ResourceLinkContent {
	type: "resource_link";
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface TextResourceContents {
	uri: string;
	mimeType?: string;
	text: string;
	_meta?: Record<string, unknown>;
}

export interface BlobResourceContents {
	uri: string;
	mimeType?: string;
	blob: string;
	_meta?: Record<string, unknown>;
}

export interface EmbeddedResourceContent {
	type: "resource";
	resource: TextResourceContents | BlobResourceContents;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLinkContent | EmbeddedResourceContent;

export interface CallToolResult {
	content: ContentBlock[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	_meta?: Record<string, unknown>;
}

/**
 * 将工具结果转换为 LLM API 接受的内容格式：文本和 Base64 图片。与
 * `@earendil-works/pi-ai` 中的 `TextContent` 和 `ImageContent` 类型。
 */
export type LlmContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function blockToLlmContent(block: ContentBlock): LlmContent {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
		case "audio":
			return { type: "text", text: `[audio ${block.mimeType} omitted]` };
		case "resource_link":
			return { type: "text", text: `${block.name}: ${block.uri}` };
		case "resource": {
			const resource = block.resource;
			if ("text" in resource) return { type: "text", text: resource.text };
			if (resource.mimeType?.startsWith("image/")) {
				return { type: "image", data: resource.blob, mimeType: resource.mimeType };
			}
			return {
				type: "text",
				text: `[binary resource ${resource.uri} (${resource.mimeType ?? "unknown type"}) omitted]`,
			};
		}
		default:
			return { type: "text", text: `[unsupported MCP content ${(block as { type: string }).type}]` };
	}
}

/**
 * 将工具结果转换为模型使用的文本和图片内容。文本和图片会直接传递；嵌入的文本资源转换为文本，
 * 嵌入的图片资源转换为图片，音频、资源链接和二进制资源等其他内容块会转换为简短的文本占位符。
 * 如果工具结果没有内容块，但包含 `structuredContent`，则将其转换为 JSON，因为服务器并不总是会
 * 将结构化结果同时写入文本内容。
 */
export function toLlmContent(result: Pick<CallToolResult, "content" | "structuredContent">): LlmContent[] {
	const content = (result.content ?? []).map(blockToLlmContent);
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	return content;
}
