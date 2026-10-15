/**
 * DOOM 覆盖层演示：以覆盖层方式游玩 DOOM。
 *
 * 用法：pi --extension ./examples/extensions/doom-overlay
 *
 * 命令：
 *   /doom-overlay - 在覆盖层中游玩 DOOM（按 Q 暂停或退出）
 *
 * 此示例展示覆盖层能够以每秒 35 帧的速度实时渲染游戏。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DoomOverlayComponent } from "./doom-component.ts";
import { DoomEngine } from "./doom-engine.ts";
import { ensureWadFile } from "./wad-finder.ts";

// 持久化引擎实例：在多次调用之间保留。
let activeEngine: DoomEngine | null = null;
let activeWadPath: string | null = null;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("doom-overlay", {
		description: "Play DOOM as an overlay. Q to pause and exit.",

		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("DOOM requires interactive mode", "error");
				return;
			}

			// 如果 WAD 文件不存在，则自动下载。
			ctx.ui.notify("Loading DOOM...", "info");
			const wad = args?.trim() ? args.trim() : await ensureWadFile();

			if (!wad) {
				ctx.ui.notify("Failed to download DOOM WAD file. Check your internet connection.", "error");
				return;
			}

			try {
				// WAD 相同时复用现有引擎，否则创建新引擎。
				let isResume = false;
				if (activeEngine && activeWadPath === wad) {
					ctx.ui.notify("Resuming DOOM...", "info");
					isResume = true;
				} else {
					ctx.ui.notify(`Loading DOOM from ${wad}...`, "info");
					activeEngine = new DoomEngine(wad);
					await activeEngine.init();
					activeWadPath = wad;
				}

				await ctx.ui.custom(
					(tui, _theme, _keybindings, done) => {
						return new DoomOverlayComponent(tui, activeEngine!, () => done(undefined), isResume);
					},
					{
						overlay: true,
						overlayOptions: {
							width: "75%",
							maxHeight: "95%",
							anchor: "center",
							margin: { top: 1 },
						},
					},
				);
			} catch (error) {
				ctx.ui.notify(`Failed to load DOOM: ${error}`, "error");
				activeEngine = null;
				activeWadPath = null;
			}
		},
	});
}
