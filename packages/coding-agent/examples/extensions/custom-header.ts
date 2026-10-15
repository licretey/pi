/**
 * 自定义页眉扩展。
 *
 * 演示如何使用 ctx.ui.setHeader() 将内置页眉（标志和按键提示）替换为
 * 显示 pi 吉祥物的自定义组件。
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";

// --- PI MASCOT ---
// 形象参考 pi_mascot.ts 中的 pi 智能体角色。
function getPiMascot(theme: Theme): string[] {
	// --- COLORS ---
	// 3b1b Blue: R=80, G=180, B=230
	const piBlue = (text: string) => theme.fg("accent", text);
	const white = (text: string) => text; // 使用纯白色（也可使用 theme.fg("text", text)）。
	const black = (text: string) => theme.fg("dim", text); // 使用暗色以增强对比度。

	// --- GLYPHS ---
	const BLOCK = "█";
	const PUPIL = "▌"; // 用作瞳孔的竖直半块字符。

	// --- CONSTRUCTION ---

	// 1. 眼睛单元：[白色实心方块][黑色竖直窄条]。
	// 这样可以营造侧视效果。
	const eye = `${white(BLOCK)}${black(PUPIL)}`;

	// 2. 第 1 行：眼睛。
	// 缩进 5 个空格，使眼睛与腿部起始位置对齐。
	const lineEyes = `     ${eye}  ${eye}`;

	// 3. 第 2 行：宽顶部横梁（“屋檐”）。
	// 使用宽 14 个方块的横梁，形成衬线式屋顶。
	const lineBar = `  ${piBlue(BLOCK.repeat(14))}`;

	// 4. 第 3 至 6 行：腿部。
	// 相对最左侧缩进 5 个空格。
	// 腿宽 2 个方块，间隔 4 个方块。
	const lineLeg = `     ${piBlue(BLOCK.repeat(2))}    ${piBlue(BLOCK.repeat(2))}`;

	// --- ASSEMBLY ---
	return ["", lineEyes, lineBar, lineLeg, lineLeg, lineLeg, lineLeg, ""];
}

export default function (pi: ExtensionAPI) {
	// 加载后立即设置自定义页眉（如果 UI 可用）。
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.setHeader((_tui, theme) => {
				return {
					render(_width: number): string[] {
						const mascotLines = getPiMascot(theme);
						// 添加带提示的副标题。
						const subtitle = `${theme.fg("muted", "   shitty coding agent")}${theme.fg("dim", ` v${VERSION}`)}`;
						return [...mascotLines, subtitle];
					},
					invalidate() {},
				};
			});
		}
	});

	// 注册用于恢复内置页眉的命令。
	pi.registerCommand("builtin-header", {
		description: "Restore built-in header with keybinding hints",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
