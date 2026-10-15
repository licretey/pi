import type { MarkdownTransformContext, MarkdownTransformer } from "../../../core/extensions/types.ts";

export function createMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	isStreaming: boolean,
	transformers: readonly MarkdownTransformer[],
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(markdown, { messageType, isStreaming, availableWidth }, transformers);
}

function applyMarkdownTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers) {
		try {
			const transformed = transformer(transformedMarkdown, context);
			if (typeof transformed === "string") {
				transformedMarkdown = transformed;
			}
		} catch {
			// 保留当前 Markdown，并继续应用下一个转换器。
		}
	}
	return transformedMarkdown;
}
