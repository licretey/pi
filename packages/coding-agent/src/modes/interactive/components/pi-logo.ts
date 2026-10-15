import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

/**
 * pi 标志宽 4 个单元格、高 2 行。每个单元格使用半块字符显示两个方形像素：
 *
 *   coral coral coral .
 *   blue  .     coral .
 *   blue  blue  .     yellow
 *   blue  .     .     yellow
 *
 * 品牌色不随主题改变，但会遵循终端的颜色模式。
 */
export function piLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const fg = (color: typeof CORAL) => foregroundAnsi(color, mode);
	// 顶行的第 4 个单元格为空，因此补上空格，使其与底行等宽。
	const top = `${fg(CORAL)}${backgroundAnsi(BLUE, mode)}▀${RESET}${fg(CORAL)}▀█${RESET} `;
	const bottom = `${fg(BLUE)}█▀${RESET} ${fg(YELLOW)}█${RESET}`;
	return [top, bottom];
}

/**
 * 判断终端能否正确渲染半块标志。Apple Terminal 会在行间绘制间隙，导致半块字符错位，
 * 因此在该终端中改用文字标志。
 */
export function supportsPiLogo(): boolean {
	return !isAppleTerminalSession();
}

/** 标志的文字回退形式：使用标志中的珊瑚色和黄色显示 "Pi"。 */
export function piWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(CORAL, mode)}P${RESET}${foregroundAnsi(YELLOW, mode)}i${RESET}`;
}
