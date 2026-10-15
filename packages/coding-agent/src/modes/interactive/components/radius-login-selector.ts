/**
 * 带有 Radius 登录动画选项的 `/login` 菜单。此组件仅供交互模式内部使用，
 * Radius 的流光动画不会提供给其他选择器。
 */

import { type Color, foregroundAnsi, mixColors, parseColor, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { ExtensionSelectorComponent } from "./extension-selector.ts";

/** Radius 标志的四种颜色，也是它们在文本上流动的顺序。 */
const RADIUS_COLORS: readonly Color[] = ["#4d9abf", "#83ccd2", "#f1be57", "#f09082"].map((hex) => parseColor(hex));
/** 每个色带的宽度，以字符数计。 */
const CHARS_PER_COLOR = 4;
const CHARS_PER_SECOND = 10;
const ANIMATION_FRAME_MS = 50;

/** 使用 Radius 标志色从左向右为 `text` 着色；`elapsedMs` 表示动画已持续的时间。 */
function radiusShimmer(text: string, elapsedMs: number): string {
	const mode = theme.getColorMode();
	const cycle = RADIUS_COLORS.length * CHARS_PER_COLOR;
	const offset = (elapsedMs / 1000) * CHARS_PER_SECOND;
	let result = "";
	let index = 0;
	for (const char of text) {
		const position = (((index - offset) % cycle) + cycle) % cycle;
		const band = Math.floor(position / CHARS_PER_COLOR);
		const t = position / CHARS_PER_COLOR - band;
		// 使用 Smoothstep 平滑过渡，同时保持每个色带清晰可辨。
		const amount = t * t * (3 - 2 * t);
		const from = RADIUS_COLORS[band] as Color;
		const to = RADIUS_COLORS[(band + 1) % RADIUS_COLORS.length] as Color;
		result += foregroundAnsi(mixColors(from, to, amount, "srgb"), mode) + char;
		index++;
	}
	return `${result}\x1b[39m`;
}

/** Radius 登录选项：`label` 是完整选项文本，并以动画文本 `text` 开头。 */
type RadiusOption = { label: string; text: string };

/**
 * 将 `ExtensionSelectorComponent` 为已选 Radius 选项绘制的行替换为动画行。若选择器行样式变化或标签换行，
 * 两行将不再匹配，此时选项会按普通方式渲染。
 */
class RadiusLoginMenuComponent extends ExtensionSelectorComponent {
	private readonly radiusOption: RadiusOption;
	private readonly animationStart = performance.now();
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private animating = false;

	constructor(
		tui: TUI,
		title: string,
		options: string[],
		radiusOption: RadiusOption,
		onSelect: (option: string) => void,
		onCancel: () => void,
	) {
		super(
			title,
			options,
			(option) => {
				this.stopAnimation();
				onSelect(option);
			},
			() => {
				this.stopAnimation();
				onCancel();
			},
		);
		this.radiusOption = radiusOption;
		this.animationTimer = setInterval(() => {
			if (this.animating) tui.requestRender();
		}, ANIMATION_FRAME_MS);
		this.animationTimer.unref?.();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const { label, text } = this.radiusOption;
		const selectedLine = new Text(theme.fg("accent", "→ ") + theme.fg("accent", label), 1, 0).render(width)[0];
		const index = selectedLine === undefined ? -1 : lines.indexOf(selectedLine);
		this.animating = index >= 0;
		if (this.animating) {
			const shimmer = radiusShimmer(text, performance.now() - this.animationStart);
			const animatedLine = theme.fg("accent", "→ ") + shimmer + label.slice(text.length);
			lines[index] = new Text(animatedLine, 1, 0).render(width)[0] ?? "";
		}
		return lines;
	}

	private stopAnimation(): void {
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
		this.animating = false;
	}

	override dispose(): void {
		this.stopAnimation();
		super.dispose();
	}
}

/** 顶层 `/login` 选择器；选中 Radius 选项时，会以 Radius 标志色显示流光动画。 */
export function createLoginMenuSelector(
	tui: TUI,
	title: string,
	options: string[],
	radiusOption: RadiusOption,
	onSelect: (option: string) => void,
	onCancel: () => void,
): ExtensionSelectorComponent {
	return new RadiusLoginMenuComponent(tui, title, options, radiusOption, onSelect, onCancel);
}
