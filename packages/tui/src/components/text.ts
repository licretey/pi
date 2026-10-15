import type { Component } from "../tui.ts";
import { applyBackgroundToLine, flattenLines, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

/**
 * 显示多行文本并自动换行的文本组件。
 */
export class Text implements Component {
	private text: string;
	private paddingX: number; // 左右内边距。
	private paddingY: number; // 上下内边距。
	private customBgFn?: (text: string) => string;

	// 渲染结果缓存。
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		this.text = text;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// 检查缓存。
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// 文本为空或仅包含空白时不渲染任何内容。
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// 将制表符替换为 3 个空格。
		const normalizedText = this.text.replace(/\t/g, "   ");

		// 必要时缩小边距，确保内容和内边距适配可用宽度。
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);

		// 对文本换行（保留 ANSI 转义码，但不补齐宽度）。
		const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);

		// 为每一行添加边距和背景色。
		const leftMargin = " ".repeat(paddingX);
		const rightMargin = " ".repeat(paddingX);
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			// 添加边距。
			const lineWithMargins = leftMargin + line + rightMargin;

			// 指定了背景色时应用背景（同时补齐至完整宽度）。
			if (this.customBgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
			} else {
				// 没有背景色时，仅使用空格补齐宽度。
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		// 添加顶部和底部内边距（空行）。
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
			emptyLines.push(line);
		}

		const result = [...emptyLines, ...contentLines, ...emptyLines];
		flattenLines(result);

		// 更新缓存。
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}
}
