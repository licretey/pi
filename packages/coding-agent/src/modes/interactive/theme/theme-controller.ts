import type { RgbColor, TerminalColors, TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import {
	getTerminalTheme,
	initTheme,
	markTerminalColorsPending,
	parseAutoThemeSetting,
	resolveThemeSetting,
	SYSTEM_THEME_NAME,
	setTerminalColorScheme,
	setTerminalColors,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.ts";

type ThemeResult = { success: boolean; error?: string };

/**
 * 系统主题保持灰度显示、随后回退到调色板索引的等待时间。终端通常会在颜色响应后立即响应末尾的 DA1 请求，
 * 因此此超时只影响两种请求都未响应的终端。之后到达的响应仍会生效。
 */
const TERMINAL_QUERY_TIMEOUT_MS = 100;

/**
 * 查询终端颜色，在查询完成或超时时将结果传给 `apply`；若终端在超时后响应，也会再次传递。
 * 查询失败时传递空颜色。首次调用 `apply` 后 Promise 即完成。
 */
export function requestTerminalColors(ui: TUI, apply: (colors: TerminalColors) => void): Promise<void> {
	let query: Promise<TerminalColors>;
	try {
		query = ui.queryTerminalColors({ timeoutMs: TERMINAL_QUERY_TIMEOUT_MS, onLateReply: apply });
	} catch {
		// 将查询失败视为终端未报告颜色。
		query = Promise.resolve({});
	}
	return query.then(apply, () => apply({}));
}

function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b);
}

function sameTerminalColors(a: TerminalColors, b: TerminalColors): boolean {
	if (!sameRgb(a.foreground, b.foreground) || !sameRgb(a.background, b.background)) return false;
	if (a.palette === b.palette) return true;
	if (!a.palette || !b.palette || a.palette.length !== b.palette.length) return false;
	return a.palette.every((color, index) => sameRgb(color, b.palette?.[index]));
}

/**
 * 应用主题设置并使其与终端保持同步。主题会立即应用，终端颜色返回后再更新主题；在此之前，
 * 系统主题以灰度显示。需要将主题颜色写入内容的调用方可以通过 `waitForTerminalColors()` 等待颜色。
 */
export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly getSettingsManager: () => SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	private currentThemeSetting: string | undefined;
	// 最近一次报告的颜色；查询超时时保留这些颜色，不清空。
	private terminalColors: TerminalColors | undefined;
	private activeThemeName: string | undefined;
	private autoSyncEnabled = false;
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;
	// 最新颜色查询完成或超时且已应用其颜色后，此 Promise 才会完成。
	private terminalColorQuery: Promise<void> = Promise.resolve();

	constructor(
		ui: TUI,
		options: {
			getSettingsManager: () => SettingsManager;
			showError: (message: string) => void;
			onChanged: () => void;
			initialThemeSetting?: string;
		},
	) {
		this.ui = ui;
		this.getSettingsManager = options.getSettingsManager;
		this.showError = options.showError;
		this.onChanged = options.onChanged;
		this.currentThemeSetting = options.initialThemeSetting;
		this.activeThemeName = this.resolveThemeName();
		// 系统主题初始以灰度显示；终端报告颜色后再应用颜色。
		markTerminalColorsPending();
		initTheme(this.activeThemeName, true);
		this.bindTerminalColorSchemeListener();
	}

	rebindTui(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(this.autoSyncEnabled);
	}

	/**
	 * 立即应用主题设置并查询终端颜色；颜色返回后会更新主题。
	 * 成对主题和系统主题会跟随终端外观变化。
	 */
	applyFromSettings(): void {
		const themeSetting = this.getThemeSetting();
		const themeName = this.resolveThemeName();
		this.setAutoSync(parseAutoThemeSetting(themeSetting) !== undefined || themeName === SYSTEM_THEME_NAME);
		this.applyThemeName(themeName, themeSetting !== undefined);
		this.queryTerminalColors();
	}

	/**
	 * 等待最新颜色查询完成或超时。将主题颜色写入字符串的内容（例如启动标题）应在此之后构建。
	 * 终端通常会在颜色响应后立即响应 DA1 请求，因此只有完全没有响应时才会等待完整超时。
	 */
	waitForTerminalColors(): Promise<void> {
		return this.terminalColorQuery;
	}

	getThemeSelection(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting() ?? this.activeThemeName;
	}

	setThemeName(themeName: string, showError = false): ThemeResult {
		this.setAutoSync(themeName === SYSTEM_THEME_NAME);
		const result = this.applyThemeName(themeName, showError);
		if (result.success) {
			this.currentThemeSetting = themeName;
		}
		return result;
	}

	setThemeSetting(themeSetting: string): void {
		this.currentThemeSetting = themeSetting;
		this.applyFromSettings();
	}

	setThemeInstance(themeInstance: Theme): ThemeResult {
		this.setAutoSync(false);
		setThemeInstance(themeInstance);
		this.activeThemeName = "<in-memory>";
		this.notifyChanged();
		return { success: true };
	}

	preview(themeSettingOrName: string): void {
		const themeName = resolveThemeSetting(themeSettingOrName, getTerminalTheme()) ?? this.activeThemeName;
		if (!themeName) return;
		if (setTheme(themeName, true).success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}

	disableAutoSync(): void {
		this.setAutoSync(false);
	}

	dispose(): void {
		this.setAutoSync(false);
		this.terminalColorSchemeUnsubscribe?.();
		this.terminalColorSchemeUnsubscribe = undefined;
	}

	getTerminalTheme(): TerminalTheme {
		return getTerminalTheme();
	}

	private getThemeSetting(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting();
	}

	/** 当前设置和终端外观对应的主题。未设置主题时，pi 使用系统主题。 */
	private resolveThemeName(): string {
		return resolveThemeSetting(this.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME;
	}

	private applyThemeName(themeName: string, showError = false): ThemeResult {
		const result = setTheme(themeName, true);
		this.activeThemeName = result.success ? themeName : SYSTEM_THEME_NAME;
		this.notifyChanged();
		if (!result.success && showError) {
			this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to the system theme.`);
		}
		return result;
	}

	/** 查询终端颜色但不等待；`waitForTerminalColors()` 会等待此查询完成。 */
	private queryTerminalColors(): void {
		this.terminalColorQuery = requestTerminalColors(this.ui, (colors) => this.applyTerminalColors(colors));
	}

	/**
	 * 记录终端报告的颜色：值为 "" 的样式令牌使用终端默认颜色；系统主题根据这些颜色生成，
	 * 明暗模式检测也会使用这些颜色。仅在颜色发生变化时重新渲染。
	 */
	private applyTerminalColors(reported: TerminalColors): void {
		const previous = this.terminalColors;
		const next: TerminalColors = {
			foreground: reported.foreground ?? previous?.foreground,
			background: reported.background ?? previous?.background,
			palette: reported.palette ?? previous?.palette,
		};
		// 重新渲染会重建所有组件，因此没有变化时（包括查询超时）跳过渲染。
		if (previous && sameTerminalColors(previous, next)) return;
		this.terminalColors = next;
		setTerminalColors(next);
		this.reapplyForTerminal();
		this.ui.invalidate();
		this.ui.requestRender();
	}

	/**
	 * 终端颜色或外观变化后重新应用设置：重新生成系统主题，或切换主题对中的主题。
	 * 通过扩展或预览设置的主题不受影响。
	 */
	private reapplyForTerminal(): void {
		if (this.activeThemeName === "<in-memory>") return;
		const themeName = this.resolveThemeName();
		if (themeName === SYSTEM_THEME_NAME || themeName !== this.activeThemeName) {
			this.applyThemeName(themeName);
		}
	}

	private setAutoSync(enabled: boolean): void {
		if (this.autoSyncEnabled === enabled) return;
		this.autoSyncEnabled = enabled;
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}

	private bindTerminalColorSchemeListener(): void {
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((terminalTheme) =>
			this.applyTerminalColorSchemeChange(terminalTheme),
		);
	}

	/**
	 * 终端报告了明暗模式切换。由于终端颜色也随之变化，需要重新查询颜色，以此确定外观。
	 * 只有不报告背景色的终端才使用其报告的明暗模式。
	 */
	private applyTerminalColorSchemeChange(terminalTheme: TerminalTheme): void {
		if (!this.autoSyncEnabled) return;
		const previous = getTerminalTheme();
		setTerminalColorScheme(terminalTheme);
		if (getTerminalTheme() !== previous) this.reapplyForTerminal();
		this.queryTerminalColors();
	}

	private notifyChanged(): void {
		this.ui.invalidate();
		this.onChanged();
	}
}
