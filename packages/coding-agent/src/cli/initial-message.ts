import type { ImageContent } from "@earendil-works/pi-ai";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
}

/**
 * 将标准输入内容、@file 文件文本和第一条命令行消息合并为非交互模式使用的初始提示。
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];
	if (stdinContent !== undefined) {
		parts.push(stdinContent);
	}
	if (fileText) {
		parts.push(fileText);
	}

	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		parsed.messages.shift();
	}

	return {
		initialMessage: parts.length > 0 ? parts.join("") : undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
