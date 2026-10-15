/**
 * 用于 `pi config` 命令的 TUI 配置选择器。
 */

import { ProcessTerminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent, type ScopedResolvedPaths } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";

export interface ConfigSelectorOptions {
	resolvedPaths: ScopedResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
	writeScope: "global" | "project";
	projectModeAvailable: boolean;
}

/** 显示 TUI 配置选择器，并在其关闭后返回。 */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// 显示 TUI 前初始化主题。
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve) => {
		const ui: TUI = new TuiMainScreen(
			new ProcessTerminal(),
			options.settingsManager.getShowHardwareCursor(),
			options.agentDir,
		);
		ui.setClearOnShrink(options.settingsManager.getClearOnShrink());
		let resolved = false;

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
			ui.terminal.rows,
			options.writeScope,
			options.projectModeAvailable,
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
