import { type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import type { EasterEgg3d } from "./easter-egg-3d.ts";

/**
 * 播放 3D 彩蛋（见 easter-egg-3d.ts），首次使用时才加载。只有全屏模式可以显示，因为动画会溶解当前画面。
 * 加载模块前会先捕获画面；无法播放时返回 false。
 */
function playEasterEgg3d(tui: TUI, egg: EasterEgg3d): boolean {
	if (!(tui instanceof TuiAltScreen)) return false;
	if (tui.hasOverlay()) return true;
	const screen = tui.getScreenLines();
	import("./easter-egg-3d.ts").then(
		(module) => module.playEasterEgg3d(tui, screen, egg),
		() => {},
	);
	return true;
}

/** 播放 3D pi 标志动画；标志从左上角位于 `column`、`row` 的标题标志处起飞。 */
export function playPiLogo3d(tui: TUI, column: number, row: number): void {
	playEasterEgg3d(tui, { kind: "pi-logo", column, row });
}

/** 播放 3D Armin 动画。无法播放时返回 false，调用方可改用行内版本。 */
export function playArmin3d(tui: TUI): boolean {
	return playEasterEgg3d(tui, { kind: "armin" });
}
