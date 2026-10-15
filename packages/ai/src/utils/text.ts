import type { ImageContent, SystemMessage, TextContent, ThinkingContent, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/** 从消息内容中提取文本并拼接。 */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

/** 将系统消息渲染为完整提示词：其内容后跟其各小节。 */
export function getSystemMessageText(message: SystemMessage): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/**
 * 为支持在对话中途接收系统消息的 API 渲染后续系统消息。
 * 小节变化用名称框起来，让模型能将其与开头的提示词关联起来。
 * 这种框架化仅在请求时生效，且可能在版本间变化。
 */
export function renderSystemMessageUpdate(message: SystemMessage): string {
	const parts: string[] = [];
	const text = contentText(message.content);
	if (text.length > 0) parts.push(text);
	for (const [name, value] of Object.entries(message.sections ?? {})) {
		parts.push(
			value === null
				? `Removed system prompt section "${name}".`
				: `Updated system prompt section "${name}":\n\n${value}`,
		);
	}
	return parts.join("\n\n");
}
