import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * 会根据视口宽度调整的动态边框组件。
 *
 * 注意：通过 jiti 加载的扩展使用此组件时，全局 `theme` 可能未定义，
 * 因为 jiti 会创建独立的模块缓存。扩展导出的组件使用 DynamicBorder 时，始终应显式传入颜色函数。
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// 当前没有需要清除的缓存状态。
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
