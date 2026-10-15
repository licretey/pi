import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	backgroundAnsi,
	type Color,
	colorToHex,
	colorToOklch,
	type EditorTheme,
	foregroundAnsi,
	getTerminalColorMode,
	indexedColor,
	type MarkdownTheme,
	mixColors,
	parseColor,
	type RgbColor,
	rgbColor,
	type SelectListTheme,
	type SettingsListTheme,
	styleTextWithAnsi,
	type TerminalColorMode,
	type TerminalColors,
	type TextAttributes,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { getCustomThemesDir, getThemesDir } from "../../../config.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { closeWatcher, watchWithErrorHandler } from "../../../utils/fs-watch.ts";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.ts";
import { stripBom } from "../../../utils/text.ts";
import { generateSystemThemeColors, SYSTEM_THEME_NAME, terminalAppearance } from "./system-theme.ts";
import {
	type ResolvedThemeColorValues,
	THEME_TOKENS,
	type ThemeBg,
	type ThemeColor,
	type ThemeColorValues,
	type ThemeToken,
} from "./theme-tokens.ts";

export { SYSTEM_THEME_NAME } from "./system-theme.ts";

// ============================================================================
// 类型与 Schema
// ============================================================================

/** 校验此结构的 schema 位于 `theme-schema.ts`；导入类型本身是零成本的。 */
import type { ThemeColorValue as ColorValue, ValidatedThemeJson as ThemeJson } from "./theme-schema.ts";

export type { ValidatedThemeJson as ThemeJson } from "./theme-schema.ts";
export type { ThemeBg, ThemeColor, ThemeToken } from "./theme-tokens.ts";

/**
 * token 只能出现在其专属的槽位中，因为 ""（终端默认色）的含义取决于槽位——可能是默认前景色或默认背景色。
 * 若要在另一个槽位中使用某个 token 的颜色，请使用 `theme.colors[token]`。
 */
export interface ThemeStyle extends TextAttributes {
	fg?: ThemeColor | Color;
	bg?: ThemeBg | Color;
}

export type ThemeJsonValidator = (label: string, json: unknown) => ThemeJson;

let themeJsonValidator: ThemeJsonValidator | undefined;

/**
 * 安装完整的主题校验。未安装时，JSON 文档会被原样接受——内置主题正是如此：校验用户编写的 JSON 需要
 * typebox，而只使用内置主题的演示场景不应为此付出约 17 MB 的模块图开销。
 */
export function setThemeJsonValidator(validator: ThemeJsonValidator): void {
	themeJsonValidator = validator;
}

// ============================================================================
// 颜色工具
// ============================================================================

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#") || /^ok(lch|hsl)\(/i.test(value)) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

function withThemeTokenFallbacks<Value>(values: ThemeColorValues<Value>): ResolvedThemeColorValues<Value> {
	const resolved = { ...values } as Partial<ResolvedThemeColorValues<Value>>;
	for (const [rawName, descriptor] of Object.entries(THEME_TOKENS)) {
		if (!("fallback" in descriptor)) continue;
		const name = rawName as ThemeToken;
		if (resolved[name] !== undefined) continue;
		const fallback = descriptor.fallback as ThemeToken;
		const fallbackValue = resolved[fallback];
		if (fallbackValue === undefined) {
			throw new Error(`Theme token ${rawName} has unresolved fallback ${descriptor.fallback}`);
		}
		resolved[name] = fallbackValue;
	}
	return resolved as ResolvedThemeColorValues<Value>;
}

// ============================================================================
// 外观与终端默认颜色
// ============================================================================

/** 主题所针对设计的背景类型。 */
export type ThemeAppearance = TerminalTheme;

// 终端上报的颜色。更新时整体替换（绝不原地修改），因此主题可以按对象身份
// 缓存已解析的颜色。
let terminalColors: TerminalColors = {};
// 当终端颜色查询尚未完成时，系统主题以灰度渲染。
let terminalColorsPending = false;
// 终端最近一次的明/暗上报（mode 2031）。仅在它尚未上报背景色时使用。
let terminalColorScheme: TerminalTheme | undefined;

/**
 * 记录终端上报的颜色。主题会把设为 ""（终端默认色）的 token 用这些默认颜色渲染；系统主题则完全由
 * 它们生成。会结束 pending 状态。
 */
export function setTerminalColors(colors: TerminalColors): void {
	terminalColors = { ...colors };
	terminalColorsPending = false;
}

/** 记录终端的明/暗上报，作为不报背景色的终端的兜底。 */
export function setTerminalColorScheme(scheme: TerminalTheme | undefined): void {
	terminalColorScheme = scheme;
}

/** 在 `setTerminalColors()` 上报终端颜色之前，让系统主题以灰度渲染。 */
export function markTerminalColorsPending(): void {
	terminalColorsPending = true;
}

/** 终端未上报时的推测默认颜色。 */
const GUESSED_DEFAULT_COLORS: Record<ThemeAppearance, { foreground: Color; background: Color }> = {
	dark: { foreground: parseColor("#e5e5e7"), background: parseColor("#000000") },
	light: { foreground: parseColor("#000000"), background: parseColor("#ffffff") },
};

function averageLightness(colors: Color[]): number | undefined {
	// 调色板 0-15 号颜色跟随用户终端的调色板，因此它们说明不了主题本身。
	const fixed = colors.filter((color) => color.kind !== "indexed" || color.index >= 16);
	if (fixed.length === 0) return undefined;
	return fixed.reduce((sum, color) => sum + colorToOklch(color).l, 0) / fixed.length;
}

/** 根据主题自身颜色的明度，检测该主题是针对深色还是浅色背景设计的。 */
function detectAppearance(foregrounds: Color[], backgrounds: Color[]): ThemeAppearance | undefined {
	const fg = averageLightness(foregrounds);
	const bg = averageLightness(backgrounds);
	if (fg !== undefined && bg !== undefined) return bg < fg ? "dark" : "light";
	if (bg !== undefined) return bg < 0.5 ? "dark" : "light";
	if (fg !== undefined) return fg > 0.5 ? "dark" : "light";
	return undefined;
}

// ============================================================================
// Theme 类
// ============================================================================

export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	private mode: TerminalColorMode;
	// 预先计算好的转义序列让渲染热路径上的 fg()/bg() 只需查表加拼接。
	private readonly fgAnsi = new Map<ThemeColor, string>();
	private readonly bgAnsi = new Map<ThemeBg, string>();
	// 设为 "" 的 token 自身没有颜色；`colors` 会用终端默认色填充它们。
	private readonly concreteColors: Partial<Record<ThemeToken, Color>> = {};
	private readonly defaultForegroundTokens: ThemeToken[] = [];
	private readonly defaultBackgroundTokens: ThemeToken[] = [];
	// 在自身颜色之上再以暗淡（SGR 2）渲染的前景 token。
	private readonly dimTokens: ReadonlySet<ThemeColor>;
	private readonly ownAppearance: ThemeAppearance | undefined;
	private resolvedColors: { terminal: TerminalColors; colors: Readonly<Record<ThemeToken, Color>> } | undefined;

	constructor(
		fgColors: Pick<ThemeColorValues<string | number>, ThemeColor>,
		bgColors: Pick<ThemeColorValues<string | number>, ThemeBg>,
		mode: TerminalColorMode,
		options: {
			name?: string;
			sourcePath?: string;
			sourceInfo?: SourceInfo;
			appearance?: ThemeAppearance;
			/** 以暗淡（SGR 2）渲染的前景 token。 */
			dim?: readonly ThemeColor[];
		} = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.mode = mode;
		this.dimTokens = new Set(options.dim);
		const { fgColors: foregrounds, bgColors: backgrounds } = splitThemeColors(
			withThemeTokenFallbacks({ ...fgColors, ...bgColors }),
		);
		const concreteForegrounds: Color[] = [];
		const concreteBackgrounds: Color[] = [];
		// 返回该 token 自身槽位对应的转义序列。
		const addToken = (token: ThemeToken, value: string | number, isBackground: boolean): string => {
			if (value === "") {
				(isBackground ? this.defaultBackgroundTokens : this.defaultForegroundTokens).push(token);
				return isBackground ? "\x1b[49m" : "\x1b[39m";
			}
			const color = parseColor(value);
			this.concreteColors[token] = color;
			(isBackground ? concreteBackgrounds : concreteForegrounds).push(color);
			return isBackground ? backgroundAnsi(color, mode) : foregroundAnsi(color, mode);
		};
		for (const [token, value] of Object.entries(foregrounds) as [ThemeColor, string | number][]) {
			this.fgAnsi.set(token, addToken(token, value, false));
		}
		for (const [token, value] of Object.entries(backgrounds) as [ThemeBg, string | number][]) {
			this.bgAnsi.set(token, addToken(token, value, true));
		}
		this.ownAppearance = options.appearance ?? detectAppearance(concreteForegrounds, concreteBackgrounds);
	}

	/**
	 * 主题所针对设计的背景类型：由主题 JSON 声明，或根据其颜色检测得出；
	 * 对于没有可用颜色的主题，则取终端的外观。
	 */
	get appearance(): ThemeAppearance {
		return this.ownAppearance ?? getTerminalTheme();
	}

	/**
	 * 所有 token 的具体颜色。设为 ""（终端默认色）的 token 使用终端上报的默认色；若终端未上报，
	 * 则基于 `appearance` 推测。暗淡（faint）token 的颜色以向背景色混合来近似。
	 */
	get colors(): Readonly<Record<ThemeToken, Color>> {
		const terminal = terminalColors;
		if (this.resolvedColors?.terminal !== terminal) {
			const guess = GUESSED_DEFAULT_COLORS[this.appearance];
			const toColor = (rgb: RgbColor | undefined, fallback: Color) =>
				rgb ? rgbColor(rgb.r, rgb.g, rgb.b) : fallback;
			const foreground = toColor(terminal.foreground, guess.foreground);
			const background = toColor(terminal.background, guess.background);
			const colors = { ...this.concreteColors };
			for (const token of this.defaultForegroundTokens) colors[token] = foreground;
			for (const token of this.defaultBackgroundTokens) colors[token] = background;
			for (const token of this.dimTokens) {
				const color = colors[token];
				if (color) colors[token] = mixColors(color, background, 0.4);
			}
			this.resolvedColors = { terminal, colors: Object.freeze(colors as Record<ThemeToken, Color>) };
		}
		return this.resolvedColors.colors;
	}

	style(text: string, options: ThemeStyle): string {
		const { fg, bg } = options;
		if (typeof fg === "string" && this.dimTokens.has(fg)) options = { ...options, dim: true };
		return styleTextWithAnsi(
			text,
			fg === undefined
				? undefined
				: typeof fg === "string"
					? this.tokenAnsi(this.fgAnsi, fg)
					: foregroundAnsi(fg, this.mode),
			bg === undefined
				? undefined
				: typeof bg === "string"
					? this.tokenAnsi(this.bgAnsi, bg)
					: backgroundAnsi(bg, this.mode),
			options,
		);
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.tokenAnsi(this.fgAnsi, color);
		if (this.dimTokens.has(color)) return `${ansi}\x1b[2m${text}\x1b[22;39m`;
		return `${ansi}${text}\x1b[39m`;
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.tokenAnsi(this.bgAnsi, color);
		return `${ansi}${text}\x1b[49m`;
	}

	private tokenAnsi<T extends ThemeToken>(ansi: Map<T, string>, token: T): string {
		const value = ansi.get(token);
		if (value === undefined) throw new Error(`Unknown theme color: ${token}`);
		return value;
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	/** 前景色 token 的起始转义序列。暗淡 token 额外包含 SGR 2，由 `\x1b[22m` 结束。 */
	getFgAnsi(color: ThemeColor): string {
		const ansi = this.tokenAnsi(this.fgAnsi, color);
		return this.dimTokens.has(color) ? `${ansi}\x1b[2m` : ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		return this.tokenAnsi(this.bgAnsi, color);
	}

	getColorMode(): TerminalColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: ThinkingLevel): (str: string) => string {
		// 将 thinking 级别映射到专用的主题颜色
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			case "max":
				return (str: string) => this.fg("thinkingMax", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

// ============================================================================
// 主题加载
// ============================================================================

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const themesDir = getThemesDir();
		const darkPath = path.join(themesDir, "dark.json");
		const lightPath = path.join(themesDir, "light.json");
		BUILTIN_THEMES = {
			dark: JSON.parse(stripBom(fs.readFileSync(darkPath, "utf-8"))) as ThemeJson,
			light: JSON.parse(stripBom(fs.readFileSync(lightPath, "utf-8"))) as ThemeJson,
		};
	}
	return BUILTIN_THEMES;
}

export function getAvailableThemes(): string[] {
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const themesDir = getThemesDir();
	const result: ThemeInfo[] = [];
	const seen = new Set<string>();
	const addTheme = (themeInfo: ThemeInfo) => {
		if (seen.has(themeInfo.name)) {
			return;
		}
		seen.add(themeInfo.name);
		result.push(themeInfo);
	};

	// 内置主题。系统主题是生成的，因此没有对应文件。
	addTheme({ name: SYSTEM_THEME_NAME, path: undefined });
	for (const name of Object.keys(getBuiltinThemes())) {
		addTheme({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// 自定义主题
	for (const themeInfo of getCustomThemeInfos()) {
		addTheme(themeInfo);
	}

	for (const [name, theme] of registeredThemes.entries()) {
		addTheme({ name, path: theme.sourcePath });
	}

	// 系统主题排在最前：它是默认主题，且能适配每一种终端。
	return result.sort((a, b) =>
		a.name === SYSTEM_THEME_NAME ? -1 : b.name === SYSTEM_THEME_NAME ? 1 : a.name.localeCompare(b.name),
	);
}

function getCustomThemeInfos(): ThemeInfo[] {
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];
	if (!fs.existsSync(customThemesDir)) {
		return result;
	}

	for (const file of fs.readdirSync(customThemesDir)) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			const customTheme = loadThemeFromPath(themePath);
			if (customTheme.name) {
				result.push({ name: customTheme.name, path: themePath });
			}
		} catch {
			// 无效主题在这里被忽略；资源加载器会在正常启动/重载时报告它们
		}
	}
	return result;
}

function assertThemeNameIsValid(name: string): void {
	if (name.includes("/")) {
		throw new Error(
			`Invalid theme name "${name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}
}

function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (themeJsonValidator) return themeJsonValidator(label, json);
	if (typeof json !== "object" || json === null || !("colors" in json)) {
		throw new Error(`Invalid theme "${label}": expected an object with a "colors" map.`);
	}
	return json as ThemeJson;
}

function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(stripBom(content));
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

function splitThemeColors(colors: ResolvedThemeColorValues<string | number>): {
	fgColors: Record<ThemeColor, string | number>;
	bgColors: Record<ThemeBg, string | number>;
} {
	const fgColors = {} as Record<ThemeColor, string | number>;
	const bgColors = {} as Record<ThemeBg, string | number>;
	for (const [key, value] of Object.entries(colors)) {
		if (THEME_TOKENS[key as ThemeToken].slot === "background") {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return { fgColors, bgColors };
}

function createTheme(themeJson: ThemeJson, mode?: TerminalColorMode, sourcePath?: string): Theme {
	const colorMode = mode ?? getTerminalColorMode();
	const resolvedColors = withThemeTokenFallbacks(resolveThemeColors(themeJson.colors, themeJson.vars));
	const { fgColors, bgColors } = splitThemeColors(resolvedColors);
	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
		appearance: themeJson.appearance,
	});
}

/** 根据终端上报的颜色生成系统主题（颜色未就绪时以灰度生成）。 */
function createSystemTheme(mode?: TerminalColorMode): Theme {
	const generated = generateSystemThemeColors({
		...terminalColors,
		saturation: terminalColorsPending ? 0 : 1,
		appearanceHint: getTerminalTheme(),
	});
	const { fgColors, bgColors } = splitThemeColors(withThemeTokenFallbacks(generated.colors));
	return new Theme(fgColors, bgColors, mode ?? getTerminalColorMode(), {
		name: SYSTEM_THEME_NAME,
		appearance: generated.appearance,
		dim: generated.dim,
	});
}

export function loadThemeFromPath(themePath: string, mode?: TerminalColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath);
}

function loadTheme(name: string, mode?: TerminalColorMode): Theme {
	// 系统主题名是保留名：它优先于同名的自定义主题。
	if (name === SYSTEM_THEME_NAME) return createSystemTheme(mode);
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name);
	} catch {
		return undefined;
	}
}

export type TerminalTheme = "dark" | "light";

export function parseAutoThemeSetting(
	themeSetting: string | undefined,
): { lightTheme: string; darkTheme: string } | undefined {
	if (!themeSetting) return undefined;
	const slashIndex = themeSetting.indexOf("/");
	if (slashIndex === -1 || themeSetting.indexOf("/", slashIndex + 1) !== -1) {
		return undefined;
	}

	const lightTheme = themeSetting.slice(0, slashIndex).trim();
	const darkTheme = themeSetting.slice(slashIndex + 1).trim();
	if (!lightTheme || !darkTheme) {
		return undefined;
	}
	return { lightTheme, darkTheme };
}

export function resolveThemeSetting(
	themeSetting: string | undefined,
	terminalTheme: TerminalTheme,
): string | undefined {
	const autoTheme = parseAutoThemeSetting(themeSetting);
	if (autoTheme) {
		return terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
	}
	if (themeSetting?.includes("/")) return undefined;
	if (typeof themeSetting === "string") return themeSetting;
	return undefined;
}

/**
 * 从部分终端会设置的 `COLORFGBG` 环境变量中判断深色或浅色；没有可用的背景索引时返回 undefined。
 * 其值为 `fg;bg` 或 `fg;xpm;bg`（rxvt），各字段是 ANSI 颜色索引，或在该颜色不在调色板中时为
 * `default`。索引指向终端自身的调色板，而其具体颜色在这里无从得知，因此像 Vim 那样按索引分类：
 * 0-6 和 8（亮黑色，例如 Solarized Dark 的背景）为深色，7 和 9-15 为浅色。
 */
export function detectColorFgBgTheme(env: NodeJS.ProcessEnv = process.env): TerminalTheme | undefined {
	const bg = env.COLORFGBG?.split(";").at(-1)?.trim();
	if (!bg || !/^\d{1,2}$/.test(bg)) return undefined;
	const index = Number(bg);
	if (index > 15) return undefined;
	return index <= 6 || index === 8 ? "dark" : "light";
}

/**
 * 终端是深色还是浅色。由它实际渲染的背景决定，分类方式与系统主题一致。
 * 没有上报的背景色时：先看终端的明/暗上报，再看 COLORFGBG，最后默认深色。
 */
export function detectTerminalTheme(
	colors: TerminalColors = {},
	reportedScheme?: TerminalTheme,
	env: NodeJS.ProcessEnv = process.env,
): TerminalTheme {
	const { background, foreground } = colors;
	if (background) return terminalAppearance(background, foreground);
	return reportedScheme ?? detectColorFgBgTheme(env) ?? "dark";
}

/** 终端是深色还是浅色，基于它到目前为止上报的所有信息。见 `detectTerminalTheme()`。 */
export function getTerminalTheme(): TerminalTheme {
	return detectTerminalTheme(terminalColors, terminalColorScheme);
}

// ============================================================================
// 全局主题实例
// ============================================================================

// 通过 globalThis 在不同模块加载器（node + 开发模式下的 jiti）之间共享主题
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

// 以 getter 的形式导出 theme，从 globalThis 读取，
// 确保所有模块实例（node、jiti）看到的是同一个主题
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
	(globalThis as Record<symbol, Theme>)[THEME_KEY_OLD] = t;
}

let currentThemeName: string | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let themeReloadTimer: NodeJS.Timeout | undefined;
let onThemeChangeCallback: (() => void) | undefined;
const registeredThemes = new Map<string, Theme>();

export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			assertThemeNameIsValid(theme.name);
			registeredThemes.set(theme.name, theme);
		}
	}
}

export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	const name = themeName ?? SYSTEM_THEME_NAME;
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// 主题无效——静默回退到系统主题
		currentThemeName = SYSTEM_THEME_NAME;
		setGlobalTheme(loadTheme(SYSTEM_THEME_NAME));
		// 不要为回退主题启动 watcher
	}
}

export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// 主题无效——回退到系统主题
		currentThemeName = SYSTEM_THEME_NAME;
		setGlobalTheme(loadTheme(SYSTEM_THEME_NAME));
		// 不要为回退主题启动 watcher
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher(); // 无法监视直接传入的实例
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

function startThemeWatcher(): void {
	stopThemeWatcher();

	// 只监视自定义主题（内置主题不监视）
	if (
		!currentThemeName ||
		currentThemeName === "dark" ||
		currentThemeName === "light" ||
		currentThemeName === SYSTEM_THEME_NAME
	) {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// 仅在文件存在时才监视
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// 切换主题或停止 watcher 之后，忽略过期的定时器
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// 文件暂时缺失时，保持上一个成功加载的主题生效
			if (!fs.existsSync(themeFile)) {
				return;
			}

			try {
				// 从磁盘重新加载主题并刷新注册表缓存
				const reloadedTheme = loadThemeFromPath(themeFile);
				registeredThemes.set(watchedThemeName, reloadedTheme);
				setGlobalTheme(reloadedTheme);
				// 通知回调（使 UI 失效重建）
				if (onThemeChangeCallback) {
					onThemeChangeCallback();
				}
			} catch (_error) {
				// 忽略错误（文件在被编辑期间可能处于无效状态）
			}
		}, 100);
	};

	themeWatcher =
		watchWithErrorHandler(
			customThemesDir,
			(_eventType, filename) => {
				if (currentThemeName !== watchedThemeName) {
					return;
				}
				if (!filename) {
					scheduleReload();
					return;
				}
				if (filename !== watchedFileName) {
					return;
				}
				scheduleReload();
			},
			() => {
				closeWatcher(themeWatcher);
				themeWatcher = undefined;
			},
		) ?? undefined;
}

export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	closeWatcher(themeWatcher);
	themeWatcher = undefined;
}

// ============================================================================
// HTML 导出辅助
// ============================================================================

/**
 * 以 CSS 兼容的 hex 字符串获取解析后的主题颜色。
 * 供 HTML 导出生成 CSS 自定义属性时使用。
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const colors = loadTheme(themeName ?? currentThemeName ?? SYSTEM_THEME_NAME).colors;
	return Object.fromEntries(Object.entries(colors).map(([token, color]) => [token, colorToHex(color)]));
}

/**
 * 检查主题是否是"浅色"主题（供需要明/暗变体的 CSS 使用）。
 */
export function isLightTheme(themeName?: string): boolean {
	return loadTheme(themeName ?? currentThemeName ?? SYSTEM_THEME_NAME).appearance === "light";
}

/**
 * 获取主题 JSON 中显式指定的导出颜色（如有）。
 * 未显式设置的颜色返回 undefined。
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? SYSTEM_THEME_NAME;
	if (name === SYSTEM_THEME_NAME) return {};
	try {
		const themeJson = loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		// 导出颜色最终会进入 CSS，而 CSS 能直接理解 hex 和 oklch() 值，但不理解 okhsl()。
		const resolve = (value: ColorValue | undefined): string | undefined => {
			if (value === undefined) return undefined;
			const resolved = resolveVarRefs(value, vars);
			if (typeof resolved === "number") return colorToHex(indexedColor(resolved));
			if (resolved === "") return undefined;
			if (/^okhsl\(/i.test(resolved)) return colorToHex(parseColor(resolved));
			return resolved;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI 辅助
// ============================================================================

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		regexp: (s: string) => t.fg("syntaxString", s),
		string: (s: string) => t.fg("syntaxString", s),
		subst: (s: string) => t.fg("text", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		doctag: (s: string) => t.fg("syntaxComment", s),
		meta: (s: string) => t.fg("muted", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		name: (s: string) => t.fg("syntaxKeyword", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		emphasis: (s: string) => t.italic(s),
		strong: (s: string) => t.bold(s),
		link: (s: string) => t.underline(s),
		addition: (s: string) => t.fg("toolDiffAdded", s),
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	};
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * 根据文件扩展名或语言，为代码添加语法着色。
 * 返回着色后的行数组。
 */
export function highlightCode(code: string, lang?: string): string[] {
	// 在高亮前先校验语言，避免 cli-highlight 向 stderr 刷屏
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	// 未指定有效语言时跳过高亮。cli-highlight 的自动检测不可靠，
	// 可能把普通散文误判成 AppleScript、LiveCodeServer 等，
	// 导致随机的英文单词被当作关键字着色。
	if (!validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * 从文件路径的扩展名获取语言标识。
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => theme.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => {
			// 在高亮前先校验语言，避免 cli-highlight 向 stderr 刷屏
			const validLang = lang && supportsLanguage(lang) ? lang : undefined;
			// 未指定有效语言时跳过高亮。cli-highlight 的自动检测不可靠，
			// 可能把普通散文误判成 AppleScript、LiveCodeServer 等，
			// 导致随机的英文单词被当作关键字着色。
			if (!validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
