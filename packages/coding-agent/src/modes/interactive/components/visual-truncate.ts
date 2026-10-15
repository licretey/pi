/**
 * 用于将文本截断为视觉行的共享工具（会考虑自动换行）。
 * 供工具渲染器和 bash-execution.ts 使用，以保持行为一致。
 */

import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

export interface VisualTruncateResult {
	/** 要显示的视觉行。 */
	visualLines: string[];
	/** 跳过（隐藏）的视觉行数。 */
	skippedCount: number;
}

/**
 * 将文本截断到指定的最大视觉行数。
 * 计算时会考虑终端宽度造成的自动换行。
 *
 * @param text - 文本内容（可能包含换行符）
 * @param maxVisualLines - 要显示的最大视觉行数
 * @param width - 终端或渲染区域的宽度
 * @param paddingX - Text 组件的水平内边距（默认为 0）。
 *                   若结果将放入 Box，请使用 0（Box 会添加自己的内边距）。
 *                   若结果将放入普通 Container，请使用 1。
 * @param keep - 保留哪些视觉行：默认保留末尾行，也可保留开头行。
 * @returns 截断后的视觉行及跳过的行数
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
	keep: "start" | "end" = "end",
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	// 创建临时 Text 组件进行渲染，并获取视觉行。
	const tempText = new Text(text, paddingX, 0);
	const allVisualLines = tempText.render(width);

	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	const truncatedLines =
		keep === "start" ? allVisualLines.slice(0, maxVisualLines) : allVisualLines.slice(-maxVisualLines);
	const skippedCount = allVisualLines.length - maxVisualLines;

	return { visualLines: truncatedLines, skippedCount };
}

export interface VisualLinePreviewOptions {
	/** 已设置样式的文本；可能包含换行符。 */
	text: string;
	maxVisualLines: number;
	/** 要保留的视觉行。提示文字位于保留的末尾行之前，或保留的开头行之后。 */
	keep: "start" | "end";
	/** 根据隐藏的视觉行数生成已设置样式的提示行。 */
	formatHint: (hidden: number) => string;
}

/**
 * 将折叠的工具输出限制为指定视觉行数，与 Bash 输出的处理方式相同。若限制逻辑行，单条长行（如压缩后的 JSON）
 * 仍可能换行并铺满整个屏幕。由于每帧都要渲染记录中的每项结果，因此按宽度缓存行数据。
 */
export class VisualLinePreview implements Component {
	private options: VisualLinePreviewOptions;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: VisualLinePreviewOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		if (this.cachedLines === undefined || this.cachedWidth !== width) {
			const { text, maxVisualLines, keep, formatHint } = this.options;
			const preview = truncateToVisualLines(text, maxVisualLines, width, 0, keep);
			const lines = preview.visualLines;
			if (preview.skippedCount > 0) {
				const hint = truncateToWidth(formatHint(preview.skippedCount), width, "...");
				this.cachedLines = keep === "start" ? [...lines, hint] : [hint, ...lines];
			} else {
				this.cachedLines = lines;
			}
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
