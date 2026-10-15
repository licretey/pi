import {
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { existsSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { areExperimentalFeaturesEnabled } from "../core/experimental.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import { SYSTEM_THEME_NAME } from "../modes/interactive/theme/system-theme.ts";
import {
	getTerminalTheme,
	initTheme,
	loadThemeFromPath,
	markTerminalColorsPending,
	resolveThemeSetting,
	setRegisteredThemes,
	setTerminalColors,
	setTheme,
	type Theme,
} from "../modes/interactive/theme/theme.ts";
import { requestTerminalColors } from "../modes/interactive/theme/theme-controller.ts";

const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const OFFICIAL_APP_NAME = "pi";
const OFFICIAL_CONFIG_DIR_NAME = ".pi";

interface DistributionMetadata {
	packageName: string;
	appName: string;
	configDirName: string;
}

function isOfficialDistribution({ packageName, appName, configDirName }: DistributionMetadata): boolean {
	return (
		packageName === OFFICIAL_PACKAGE_NAME &&
		appName === OFFICIAL_APP_NAME &&
		configDirName === OFFICIAL_CONFIG_DIR_NAME
	);
}

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// 主题损坏不应导致启动提示失败。常规资源加载器会在启动后续阶段
			// 报告主题诊断信息。
		}
	}
	return themes;
}

async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	// 系统主题在终端报告颜色前以灰度显示。
	markTerminalColorsPending();
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	const themeSetting = settingsManager.getThemeSetting();
	queryStartupTerminalColors(ui, () => {
		setTheme(resolveThemeSetting(themeSetting, getTerminalTheme()) ?? SYSTEM_THEME_NAME);
	});
}

/**
 * 查询终端颜色但不等待结果。颜色返回后（包括超时后才返回的情况），将其记录下来，
 * 供系统主题和值为 ""（终端默认色）的样式令牌使用，然后运行 `onColors` 并重新渲染。
 */
function queryStartupTerminalColors(ui: TUI, onColors: () => void): void {
	void requestTerminalColors(ui, (colors) => {
		setTerminalColors(colors);
		onColors();
		ui.invalidate();
		ui.requestRender();
	});
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * 满足以下所有条件时运行首次设置：
 * - 当前使用官方 Pi 分发版本（不是分支或重新命名的版本）。
 * - 已启用实验功能（PI_EXPERIMENTAL=1）。
 * - 使用默认代理目录（未覆盖代理目录）。
 * - 尚未完成设置（settings.json 不存在）。
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (
		!isOfficialDistribution({
			packageName: PACKAGE_NAME,
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
		})
	) {
		return false;
	}
	if (!areExperimentalFeaturesEnabled()) {
		return false;
	}
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	return !existsSync(settingsPath);
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

/** 显示首次设置对话框并持久化结果。 */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		ui.start();
		let previewTheme = SYSTEM_THEME_NAME;
		setTheme(previewTheme);
		const component = new FirstTimeSetupComponent({
			onThemePreview: (themeName) => {
				previewTheme = themeName;
				setTheme(themeName);
				ui.requestRender();
			},
			onSubmit: (result) => void finish(result),
			onCancel: () => void finish(undefined),
		});
		ui.addChild(component);
		ui.setFocus(component);
		ui.requestRender();
		// 终端颜色会重新生成系统主题；重新渲染后，对话框也会使用新主题。
		queryStartupTerminalColors(ui, () => setTheme(previewTheme));
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
