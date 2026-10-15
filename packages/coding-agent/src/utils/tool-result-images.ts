import type { ImageContent, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { processImage } from "./image-process.ts";

export type ToolResultContent = TextContent | ImageContent;

export interface NormalizeToolResultImagesOptions {
	/** 是否将超大图像缩放到提供商的内联图像限制内。默认值：true。 */
	autoResizeImages?: boolean;
	/** 模型专用的缩放配置；省略时使用较保守的内置默认值。 */
	resizeOptions?: ModelImageResizeOptions;
}

/**
 * 规范化工具结果中的图像块。
 *
 * `read` 工具和 `@file` 命令行附件会通过 `processImage` 处理图像，但自行生成图像的工具
 *（例如扩展、MCP 桥接和截图工具）可能会返回任意格式的
 * Base64 数据，并直接写入会话历史及后续的每次提供商请求。
 * 超大图像会导致提供商拒绝整个对话，而不只是出问题的那一轮，
 * 因此应在图像进入历史记录时统一规范化。
 *
 * 如果内容没有变化，则返回原数组，调用方无需重写结果。
 */
export async function normalizeToolResultImages(
	content: ToolResultContent[],
	options?: NormalizeToolResultImagesOptions,
): Promise<ToolResultContent[]> {
	if (!content.some((block) => block.type === "image")) {
		return content;
	}

	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized: ToolResultContent[] = [];
	let changed = false;

	for (const block of content) {
		if (block.type !== "image") {
			normalized.push(block);
			continue;
		}

		const processed = await processImage(Buffer.from(block.data, "base64"), block.mimeType, {
			autoResizeImages,
			resizeOptions: options?.resizeOptions,
		});
		if (!processed.ok) {
			// 与 `read` 不同，这里保留原图像块。该图像由工具生成，处理
			// 失败可能只是因为图像后端不可用；直接透传可以保留工具当前的
			// 行为，避免静默丢弃工具输出。
			normalized.push(block);
			continue;
		}

		if (processed.data === block.data && processed.mimeType === block.mimeType && processed.hints.length === 0) {
			normalized.push(block);
			continue;
		}

		normalized.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		if (processed.hints.length > 0) {
			normalized.push({ type: "text", text: processed.hints.join("\n") });
		}
		changed = true;
	}

	return changed ? normalized : content;
}
