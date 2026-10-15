import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

/**
 * 将文本截断至视口宽度以内的文本组件。
 */
export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {
		// 当前没有需要失效处理的缓存状态。
	}

	render(width: number): string[] {
		const result: string[] = [];

		// 补齐至指定宽度的空行。
		const emptyLine = " ".repeat(width);

		// 添加顶部垂直内边距。
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		// 计算扣除水平内边距后的可用宽度。
		const availableWidth = Math.max(1, width - this.paddingX * 2);

		// 仅保留第一行（遇到换行符即停止）。
		let singleLineText = this.text;
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.text.substring(0, newlineIndex);
		}

		// 必要时截断文本，并计入 ANSI 转义码的影响。
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// 添加水平内边距。
		const leftPadding = " ".repeat(this.paddingX);
		const rightPadding = " ".repeat(this.paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// 将行补齐至指定的可见宽度。
		const lineVisibleWidth = visibleWidth(lineWithPadding);
		const paddingNeeded = Math.max(0, width - lineVisibleWidth);
		const finalLine = lineWithPadding + " ".repeat(paddingNeeded);

		result.push(finalLine);

		// 添加底部垂直内边距。
		for (let i = 0; i < this.paddingY; i++) {
			result.push(emptyLine);
		}

		return result;
	}
}
