import { Text } from "@earendil-works/pi-tui";

/**
 * 内容会应用主题颜色的文本组件。普通 `Text` 会保留创建字符串时使用的颜色，因此切换主题或系统主题
 * 接收终端颜色后，颜色会过期。本组件在每次失效后都通过 `build` 重新生成字符串；界面会在主题变化时使其失效。
 *
 * 除颜色外，`build` 每次都必须返回相同内容。创建组件前应先固定可能变化的数据；若 `build` 读取的状态发生变化，
 * 则调用 `invalidate()`。
 */
export class ThemedText extends Text {
	private readonly build: () => string;
	private stale = true;

	constructor(build: () => string, paddingX = 1, paddingY = 1) {
		super("", paddingX, paddingY);
		this.build = build;
	}

	override invalidate(): void {
		super.invalidate();
		this.stale = true;
	}

	override render(width: number): string[] {
		if (this.stale) {
			this.stale = false;
			this.setText(this.build());
		}
		return super.render(width);
	}
}
