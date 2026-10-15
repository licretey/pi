/**
 * `system` 主题：根据终端自身主题生成 pi 的配色。
 *
 * 每个颜色标记都属于一个色彩系列（由色相决定），并遵循对比度规则：在其背景和面板上必须达到指定对比度。
 * 色相和饱和度取自终端调色板中该系列对应 ANSI 槽位的颜色；若终端未提供调色板，则使用该系列自身的色相。
 * 明度仅由规则决定。颜色使用 OKHSL 构造，其饱和度相对于 sRGB 色域定义，并会在接近黑色或白色时逐渐变灰。
 * 调色板颜色改变明度时不会增加 OKLCH 色度，因此粉彩调色板仍会保持粉彩效果。
 *
 * 对比度级别是一条目标明度曲线：根据底层表面的明度，计算颜色标记在 OKLab 中所需的明度。
 * 这些曲线依据“Pi themes: system and light/dark”设计评审中的参考主题拟合而成。
 * 深色背景下，目标明度基本保持不变；浅色背景下，背景越暗，所需的明度差越大。
 *
 * 根据终端提供的信息，主题按以下三种方式之一生成：
 * - 同时提供背景和调色板：色相取自调色板，明度取决于背景；
 * - 仅提供背景：使用各色彩系列自身的色相，明度取决于背景；
 * - 两者均未提供：使用 ANSI 调色板索引和默认颜色，由终端自行渲染。
 */

import {
	colorToOkhsl,
	colorToOklch,
	colorToRgb,
	type OkhslChannels,
	okhslColor,
	oklabToOkhslLightness,
	oklchColor,
	type RgbColor,
	rgbColor,
} from "@earendil-works/pi-tui";
import type { ThemeAppearance, ThemeBg, ThemeColor, ThemeToken } from "./theme.ts";

export const SYSTEM_THEME_NAME = "system";

// ============================================================================
// 配色方案：色彩系列及其颜色标记。
// ============================================================================

/** 色彩系列在 OKHSL 中的色相和饱和度：中等明度时达到 `max`，接近黑色和白色时降至 `min`。 */
interface Family {
	hue: number;
	saturation: { min: number; max: number };
	/** 此系列用于获取色相和饱和度的 ANSI 调色板槽位。 */
	slot: number;
}

const FAMILIES = {
	neutral: { hue: 231.49, saturation: { min: 0.02, max: 0.08 }, slot: 8 },
	blue: { hue: 231.49, saturation: { min: 0.1, max: 0.68 }, slot: 4 },
	green: { hue: 158.68, saturation: { min: 0.1, max: 0.76 }, slot: 2 },
	red: { hue: 20, saturation: { min: 0.1, max: 0.92 }, slot: 1 },
	yellow: { hue: 82.36, saturation: { min: 0.5, max: 1 }, slot: 3 },
	orange: { hue: 52, saturation: { min: 0.12, max: 0.85 }, slot: 3 },
	violet: { hue: 295, saturation: { min: 0.2, max: 0.6 }, slot: 5 },
	calamine: { hue: 202.43, saturation: { min: 0.1, max: 0.74 }, slot: 6 },
	thinkingSlate: { hue: 231.49, saturation: { min: 0.08, max: 0.2 }, slot: 4 },
	thinkingBlue: { hue: 231.49, saturation: { min: 0.2, max: 0.45 }, slot: 4 },
	thinkingPeriwinkle: { hue: 263.25, saturation: { min: 0.3, max: 0.6 }, slot: 6 },
	thinkingViolet: { hue: 295, saturation: { min: 0.4, max: 0.75 }, slot: 5 },
	thinkingMagenta: { hue: 337.5, saturation: { min: 0.5, max: 0.85 }, slot: 13 },
	thinkingRed: { hue: 20, saturation: { min: 0.95, max: 1 }, slot: 1 },
} satisfies Record<string, Family>;

type FamilyName = keyof typeof FAMILIES;

const TOKEN_FAMILIES: Record<ThemeToken, FamilyName> = {
	selectedBg: "blue",
	searchMatchBg: "orange",
	userMessageBg: "blue",
	customMessageBg: "violet",
	toolPendingBg: "neutral",
	toolSuccessBg: "green",
	toolErrorBg: "red",

	text: "neutral",
	userMessageText: "neutral",
	customMessageText: "neutral",
	toolTitle: "neutral",
	syntaxOperator: "neutral",
	syntaxPunctuation: "neutral",
	muted: "neutral",
	dim: "neutral",
	thinkingText: "neutral",
	toolOutput: "neutral",
	mdLinkUrl: "neutral",
	mdQuote: "neutral",
	mdQuoteBorder: "neutral",
	mdHr: "neutral",
	mdCodeBlockBorder: "neutral",
	toolDiffContext: "neutral",
	syntaxComment: "neutral",
	scrollbarTrack: "neutral",
	scrollbarThumb: "neutral",
	searchMatchText: "neutral",
	borderMuted: "neutral",

	accent: "violet",
	borderAccent: "violet",
	customMessageLabel: "violet",
	mdCode: "violet",
	mdListBullet: "violet",
	syntaxType: "violet",
	border: "blue",
	mdLink: "blue",
	syntaxKeyword: "blue",
	syntaxVariable: "calamine",
	success: "green",
	mdCodeBlock: "green",
	toolDiffAdded: "green",
	bashMode: "green",
	syntaxNumber: "green",
	error: "red",
	toolDiffRemoved: "red",
	warning: "yellow",
	mdHeading: "yellow",
	syntaxFunction: "yellow",
	syntaxString: "orange",

	thinkingOff: "neutral",
	thinkingMinimal: "thinkingSlate",
	thinkingLow: "thinkingBlue",
	thinkingMedium: "thinkingPeriwinkle",
	thinkingHigh: "thinkingViolet",
	thinkingXhigh: "thinkingMagenta",
	thinkingMax: "thinkingRed",
};

/** 为颜色标记指定调色板槽位，避免与相似标记共用同一色相。 */
const TOKEN_SLOTS: Partial<Record<ThemeToken, number>> = { syntaxString: 2, syntaxNumber: 5, searchMatchBg: 3 };

// ============================================================================
// 对比度级别和规则。
// ============================================================================

/**
 * 目标明度曲线：以表面的 OKLab 明度为自变量的多项式，给出颜色标记在该表面上所需的 OKLab 明度。
 * `reachable` 表示可以达到此级别的表面明度范围；超出该范围时会放宽级别要求。
 */
interface Curve {
	coefficients: number[];
	reachable: [number, number];
}

const LEVELS = {
	panel: {
		dark: { coefficients: [0.29131, -0.39746, 2.33185, -0.85524, -1.2076, 0.86276], reachable: [0, 0.979] },
		light: { coefficients: [-3.74073, 27.94549, -78.44258, 112.6798, -79.60015, 22.11277], reachable: [0.348, 1] },
	},
	track: {
		dark: { coefficients: [0.39028, -0.23015, 0.83573, 2.43829, -4.38292, 2.01582], reachable: [0, 0.946] },
		light: { coefficients: [-5.24921, 38.37322, -107.28833, 152.10005, -106.17127, 29.18061], reachable: [0.368, 1] },
	},
	thinking0: {
		dark: { coefficients: [0.52988, -0.05809, -0.30924, 4.63567, -6.52933, 2.89108], reachable: [0, 0.873] },
		light: {
			coefficients: [-28.27749, 182.85284, -469.62416, 603.15916, -384.59976, 97.35147],
			reachable: [0.51, 1],
		},
	},
	thinking1: {
		dark: { coefficients: [0.55278, -0.03667, -0.45659, 4.95347, -6.90265, 3.0706], reachable: [0, 0.858] },
		light: {
			coefficients: [-37.10484, 235.86282, -596.62344, 754.3633, -474.00763, 118.3551],
			reachable: [0.535, 1],
		},
	},
	thinking2: {
		dark: { coefficients: [0.57486, -0.01765, -0.58987, 5.25227, -7.27175, 3.25532], reachable: [0, 0.842] },
		light: {
			coefficients: [-59.89653, 377.05024, -945.07843, 1182.03145, -734.96375, 181.68658],
			reachable: [0.556, 1],
		},
	},
	thinking3: {
		dark: { coefficients: [0.59621, -0.00062, -0.71148, 5.53588, -7.6392, 3.44606], reachable: [0, 0.827] },
		light: {
			coefficients: [-72.07122, 445.84082, -1099.57352, 1353.88793, -829.53392, 202.26164],
			reachable: [0.58, 1],
		},
	},
	thinking4: {
		dark: { coefficients: [0.61691, 0.01462, -0.82288, 5.80651, -8.00641, 3.64333], reachable: [0, 0.811] },
		light: {
			coefficients: [-110.14338, 674.21488, -1645.75941, 2004.32367, -1215.15899, 293.3183],
			reachable: [0.6, 1],
		},
	},
	thinking5: {
		dark: { coefficients: [0.63702, 0.02826, -0.92498, 6.06465, -8.37246, 3.84651], reachable: [0, 0.795] },
		light: {
			coefficients: [-175.47701, 1063.54495, -2570.70594, 3098.80776, -1860.15527, 444.76392],
			reachable: [0.62, 1],
		},
	},
	thinking6: {
		dark: { coefficients: [0.65658, 0.04044, -1.01835, 6.30989, -8.73529, 4.05439], reachable: [0, 0.779] },
		light: {
			coefficients: [-183.81712, 1094.70055, -2602.68539, 3088.71276, -1826.91131, 430.75931],
			reachable: [0.643, 1],
		},
	},
	subtle: {
		dark: { coefficients: [0.56762, -0.02475, -0.5383, 5.12628, -7.10931, 3.17324], reachable: [0, 0.848] },
		light: {
			coefficients: [-232.85459, 1376.54473, -3249.11801, 3827.91186, -2248.29472, 526.55751],
			reachable: [0.657, 1],
		},
	},
	thumb: {
		dark: { coefficients: [0.60323, 0.00278, -0.73328, 5.57157, -7.68067, 3.46933], reachable: [0, 0.823] },
		light: {
			coefficients: [-82.89897, 511.01355, -1255.98095, 1540.76821, -940.68087, 228.58523],
			reachable: [0.586, 1],
		},
	},
	readable: {
		dark: { coefficients: [0.66937, 0.04704, -1.06871, 6.43941, -8.9332, 4.17229], reachable: [0, 0.77] },
		light: {
			coefficients: [-1554.52576, 8733.56817, -19604.93507, 21977.72696, -12300.99599, 2749.81288],
			reachable: [0.751, 1],
		},
	},
	emphasis: {
		dark: { coefficients: [0.7303, 0.07695, -1.31626, 7.1681, -10.14436, 4.92846], reachable: [0, 0.712] },
		light: {
			coefficients: [-4948.31942, 26870.91986, -58334.48399, 63280.17197, -34298.01053, 7430.30146],
			reachable: [0.811, 1],
		},
	},
	textOnPanel: {
		dark: { coefficients: [0.86713, 0.05232, -0.89428, 4.79014, -5.5432, 1.75023], reachable: [0, 0.542] },
		light: {
			coefficients: [-8570.89457, 43954.60805, -90084.00702, 92220.6791, -47152.15802, 9632.27113],
			reachable: [0.867, 1],
		},
	},
	text: {
		dark: { coefficients: [0.89242, 0.02311, -0.44862, 2.34417, -0.06084, -2.63844], reachable: [0, 0.5] },
		light: {
			coefficients: [-2004.67048, 6664.47299, -6060.70202, -1792.61209, 5133.82359, -1939.85583],
			reachable: [0.894, 1],
		},
	},
} satisfies Record<string, Record<ThemeAppearance, Curve>>;

type Level = keyof typeof LEVELS;

type Surface = ThemeBg | "background" | "scrollbarTrack";

interface Rule {
	token: ThemeToken;
	on: Surface[];
	level: Level;
}

const TOOL_PANELS: Surface[] = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"];
const MESSAGE_PANELS: Surface[] = ["userMessageBg", "customMessageBg"];
const PANELS: ThemeBg[] = [
	"userMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"selectedBg",
	"searchMatchBg",
	"customMessageBg",
];
const THINKING: ThemeColor[] = [
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
];
const THINKING_LEVELS: Level[] = [
	"thinking0",
	"thinking1",
	"thinking2",
	"thinking3",
	"thinking4",
	"thinking5",
	"thinking6",
];

const each = (tokens: ThemeToken[], on: Surface[], level: Level): Rule[] =>
	tokens.map((token) => ({ token, on, level }));

const RULES: Rule[] = [
	...each(PANELS, ["background"], "panel"),
	{ token: "text", on: ["background"], level: "text" },
	{ token: "text", on: ["selectedBg"], level: "textOnPanel" },
	{ token: "userMessageText", on: ["userMessageBg"], level: "textOnPanel" },
	{ token: "toolTitle", on: TOOL_PANELS, level: "textOnPanel" },
	...each(["accent", "success", "error", "warning"], ["background", "selectedBg", ...TOOL_PANELS], "readable"),
	{ token: "muted", on: ["background", "selectedBg", "customMessageBg", ...TOOL_PANELS], level: "readable" },
	{ token: "dim", on: ["background", "selectedBg", "customMessageBg", ...TOOL_PANELS], level: "subtle" },
	{ token: "thinkingText", on: ["background"], level: "readable" },
	{ token: "customMessageText", on: ["customMessageBg", ...TOOL_PANELS], level: "readable" },
	{
		token: "customMessageLabel",
		on: ["background", "customMessageBg", "selectedBg", ...TOOL_PANELS],
		level: "readable",
	},
	{ token: "toolOutput", on: ["background", ...TOOL_PANELS], level: "readable" },
	...each(
		["mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdQuote", "mdCodeBlockBorder", "mdListBullet"],
		["background", ...MESSAGE_PANELS],
		"readable",
	),
	{ token: "mdCodeBlock", on: ["background", ...MESSAGE_PANELS, ...TOOL_PANELS], level: "readable" },
	...each(["toolDiffAdded", "toolDiffRemoved", "toolDiffContext"], ["background", ...TOOL_PANELS], "readable"),
	...each(
		[
			"syntaxComment",
			"syntaxKeyword",
			"syntaxFunction",
			"syntaxVariable",
			"syntaxString",
			"syntaxNumber",
			"syntaxType",
			"syntaxOperator",
			"syntaxPunctuation",
		],
		["background", ...MESSAGE_PANELS, ...TOOL_PANELS],
		"readable",
	),
	{ token: "searchMatchText", on: ["searchMatchBg"], level: "readable" },
	...each(["bashMode", "border", "borderAccent"], ["background"], "readable"),
	{ token: "borderMuted", on: ["background"], level: "subtle" },
	...each(["mdQuoteBorder", "mdHr"], ["background", ...MESSAGE_PANELS, ...TOOL_PANELS], "readable"),
	{ token: "scrollbarTrack", on: ["background"], level: "track" },
	{ token: "scrollbarThumb", on: ["scrollbarTrack"], level: "thumb" },
	...THINKING.map((token, index): Rule => ({ token, on: ["background"], level: THINKING_LEVELS[index] })),
];

/** 放宽对比度时，先将高于此级别的要求压缩到此级别，再统一降低所有级别。 */
const READABLE_FLOOR: Record<ThemeAppearance, Level> = { dark: "readable", light: "subtle" };

/** 正文达到此级别时使用终端前景色；该级别的对比度明显高于 muted。 */
const FOREGROUND_LEVEL: Level = "emphasis";

/** 使用终端前景色的文本类颜色标记。 */
const FOREGROUND_TOKENS: ThemeColor[] = ["text", "userMessageText", "toolTitle"];

/** 正文在其所绘制表面上必须达到的 WCAG 2 对比度。 */
const TEXT_MINIMUM_WCAG_CONTRAST = 4.5;

/** 按依赖顺序排列的颜色标记：每个表面都排在绘制于其上的标记之前。 */
const SOLVE_ORDER: ThemeToken[] = (() => {
	const order: ThemeToken[] = [];
	const visit = (token: ThemeToken): void => {
		if (order.includes(token)) return;
		for (const rule of RULES) {
			if (rule.token !== token) continue;
			for (const surface of rule.on) if (surface !== "background") visit(surface);
		}
		order.push(token);
	};
	for (const rule of RULES) visit(rule.token);
	return order;
})();

// ============================================================================
// 公共 API。
// ============================================================================

export interface SystemThemeInput {
	foreground?: RgbColor;
	background?: RgbColor;
	/** ANSI 颜色 0 到 15。 */
	palette?: RgbColor[];
	/** 饱和度倍率，范围为 0（灰度）到 1。收到颜色信息前，首帧以灰度渲染。 */
	saturation?: number;
	/** 终端未报告背景色时使用的明暗外观，例如依据其明暗报告或 COLORFGBG 环境变量确定。 */
	appearanceHint?: ThemeAppearance;
}

export interface SystemThemeColors {
	/** 十六进制颜色、ANSI 调色板索引；空字符串表示使用终端默认颜色。 */
	colors: Record<ThemeToken, string | number>;
	/** 对于未报告颜色的终端，以淡化效果（SGR 2）渲染的前景颜色标记。 */
	dim: ThemeColor[];
	appearance: ThemeAppearance | undefined;
}

/** sRGB 颜色在 OKLab 中的明度，范围为 0 到 1。 */
function oklabLightness(color: RgbColor): number {
	return colorToOklch(rgbColor(color.r, color.g, color.b)).l;
}

/** WCAG 2 相对亮度。 */
export function relativeLuminance({ r, g, b }: RgbColor): number {
	const linear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2 对比度，范围为 1 到 21。 */
export function wcagContrast(first: RgbColor, second: RgbColor): number {
	const a = relativeLuminance(first);
	const b = relativeLuminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * 根据终端报告的颜色判断其属于深色还是浅色：若终端前景色与背景色的明暗关系能保证文本可读，则据此判定；
 * 否则，若白色文本在背景上的对比度高于黑色文本，则判定为深色主题。
 */
export function terminalAppearance(background: RgbColor, foreground?: RgbColor): ThemeAppearance {
	const white = { r: 255, g: 255, b: 255 };
	const black = { r: 0, g: 0, b: 0 };
	const whiteContrast = wcagContrast(white, background);
	const blackContrast = wcagContrast(black, background);
	if (foreground) {
		const foregroundL = oklabLightness(foreground);
		const backgroundL = oklabLightness(background);
		if (Math.abs(foregroundL - backgroundL) > 0.05) {
			const appearance = foregroundL > backgroundL ? "dark" : "light";
			const best = appearance === "dark" ? whiteContrast : blackContrast;
			if (best >= TEXT_MINIMUM_WCAG_CONTRAST) return appearance;
		}
	}
	return whiteContrast >= blackContrast ? "dark" : "light";
}

// ============================================================================
// 配色生成。
// ============================================================================

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function hexOf({ r, g, b }: RgbColor): string {
	return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** 给定明度下的饱和度权重：高斯曲线中心为 0.5、标准差为 0.25；黑白两端为 0，中间为 1。 */
function bellWeight(lightness: number): number {
	const gaussian = (x: number): number => Math.exp(-((x - 0.5) ** 2) / (2 * 0.25 ** 2));
	return (gaussian(lightness) - gaussian(0)) / (1 - gaussian(0));
}

/** 色彩系列相对于最大值的饱和度曲线：中等明度时为 1，黑白两端为 `min / max`。 */
function saturationCurve({ saturation: { min, max } }: Family, lightness: number): number {
	const floor = max > 0 ? min / max : 1;
	return floor + (1 - floor) * bellWeight(lightness);
}

/** 某表面上指定级别的目标明度；无法达到该级别时返回 undefined。 */
function levelTarget(level: Level, appearance: ThemeAppearance, surfaceL: number): number | undefined {
	const curve: Curve = LEVELS[level][appearance];
	if (surfaceL < curve.reachable[0] || surfaceL > curve.reachable[1]) return undefined;
	return curve.coefficients.reduce((sum, coefficient, power) => sum + coefficient * surfaceL ** power, 0);
}

/**
 * 根据终端报告的颜色生成系统主题配色。
 */
export function generateSystemThemeColors(input: SystemThemeInput): SystemThemeColors {
	const saturation = clamp(input.saturation ?? 1, 0, 1);
	const { background, foreground } = input;
	if (!background) return indexedColors(saturation, input.appearanceHint);
	const palette = input.palette?.length === 16 ? input.palette.map(sourceOf) : undefined;

	const appearance = terminalAppearance(background, foreground);
	const lighter = appearance === "dark";
	const extreme = lighter ? 1 : 0;
	const backgroundL = oklabLightness(background);

	/**
	 * 获取颜色标记在指定 OKLab 明度下的颜色。使用调色板时，调色板颜色在自身明度下的饱和度会作为基准，
	 * 并沿该色彩系列的曲线向黑白两端递减，且不会超过曲线规定的上限。
	 */
	const paint = (token: ThemeToken, oklabL: number): RgbColor => {
		const lightness = oklabToOkhslLightness(oklabL);
		const family: Family = FAMILIES[TOKEN_FAMILIES[token]];
		if (!palette) {
			const { min, max } = family.saturation;
			return okhslColor(family.hue, (min + (max - min) * bellWeight(lightness)) * saturation, lightness);
		}
		return anchored(palette[TOKEN_SLOTS[token] ?? family.slot], family, lightness, saturation);
	};

	/**
	 * 规则在表面上所需的明度，并根据 `t` 放宽：`t` 从 0 到 1 时，高于可读性下限的级别向下限靠拢；
	 * `t` 从 1 到 2 时，所有级别都向表面自身的明度靠拢。
	 */
	const target = (level: Level, surfaceL: number, t: number): number | undefined => {
		const reached = levelTarget(level, appearance, surfaceL);
		if (reached === undefined && t === 0) return undefined;
		const distance = (reached ?? extreme) - surfaceL;
		const floor = (levelTarget(READABLE_FLOOR[appearance], appearance, surfaceL) ?? extreme) - surfaceL;
		const compressed =
			Math.abs(distance) > Math.abs(floor) ? distance - (distance - floor) * Math.min(t, 1) : distance;
		return surfaceL + compressed * (1 - Math.max(0, t - 1));
	};

	/**
	 * 限制面板明度，使其足够浅（或足够深），确保白色（或黑色）文本仍能达到正文的最低对比度要求。
	 * 这只影响接近中灰色的背景，因为在这种背景上正文对比度本就勉强达标。
	 */
	const extremeText = lighter ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
	const readable = (color: RgbColor) => wcagContrast(extremeText, color) >= TEXT_MINIMUM_WCAG_CONTRAST;
	const limitPanel = (token: ThemeToken, l: number): RgbColor => {
		const color = paint(token, l);
		if (readable(color)) return color;
		let [low, high] = [backgroundL, l];
		for (let index = 0; index < 20; index++) {
			const middle = (low + high) / 2;
			if (readable(paint(token, middle))) low = middle;
			else high = middle;
		}
		return paint(token, low);
	};

	const solve = (t: number): Map<Surface | ThemeToken, RgbColor> | undefined => {
		const colors = new Map<Surface | ThemeToken, RgbColor>([["background", background]]);
		for (const token of SOLVE_ORDER) {
			const targets: number[] = [];
			for (const rule of RULES) {
				if (rule.token !== token) continue;
				for (const surface of rule.on) {
					const value = target(rule.level, oklabLightness(colors.get(surface) ?? background), t);
					if (value === undefined || value < 0 || value > 1) return undefined;
					targets.push(value);
				}
			}
			const l = lighter ? Math.max(...targets) : Math.min(...targets);
			colors.set(token, PANELS.includes(token as ThemeBg) ? limitPanel(token, l) : paint(token, l));
		}
		return colors;
	};

	let relaxation = 0;
	let colors = solve(0);
	if (!colors) {
		// 中灰色背景无法满足所有对比度级别：尽可能少地放宽要求。完全放宽时总能找到可行结果。
		let [low, high] = [0, 2];
		colors = solve(high);
		for (let index = 0; index < 20; index++) {
			const middle = (low + high) / 2;
			const attempt = solve(middle);
			if (attempt) [high, colors] = [middle, attempt];
			else low = middle;
		}
		relaxation = high;
	}
	const solved = colors ?? new Map<Surface | ThemeToken, RgbColor>();
	const surfacesOf = (token: ThemeToken) =>
		RULES.filter((rule) => rule.token === token).flatMap((rule) =>
			rule.on.map((surface) => solved.get(surface) ?? background),
		);

	const result = {} as Record<ThemeToken, string | number>;
	for (const token of Object.keys(TOKEN_FAMILIES) as ThemeToken[]) {
		const color = solved.get(token);
		result[token] = color ? hexOf(color) : "";
	}

	for (const token of FOREGROUND_TOKENS) {
		const surfaces = surfacesOf(token);
		// 终端前景色的对比度明显高于 muted 时，正文直接使用该颜色；否则保留其色相，并调整到刚好满足要求的明度。
		let text = solved.get(token);
		if (foreground) {
			const targets = surfaces.map((surface) => target(FOREGROUND_LEVEL, oklabLightness(surface), relaxation));
			if (targets.every((value) => value !== undefined && value >= 0 && value <= 1)) {
				const needed = lighter ? Math.max(...(targets as number[])) : Math.min(...(targets as number[]));
				const foregroundL = oklabLightness(foreground);
				if (lighter ? foregroundL >= needed : foregroundL <= needed) {
					result[token] = "";
					continue;
				}
				text = anchored(sourceOf(foreground), FAMILIES.neutral, oklabToOkhslLightness(needed), saturation);
			}
		}
		// 即使中灰色背景下的对比度要求已放宽，正文在其绘制表面上的对比度仍至少为 4.5:1。
		if (text) result[token] = hexOf(withTextContrast(text, surfaces, lighter));
	}
	return { colors: result, dim: [], appearance };
}

function okhslOf({ r, g, b }: RgbColor): OkhslChannels {
	return colorToOkhsl(rgbColor(r, g, b));
}

/** 终端颜色的 OKHSL 通道及其 OKLCH 色度。 */
interface SourceColor extends OkhslChannels {
	chroma: number;
}

function sourceOf(color: RgbColor): SourceColor {
	return { ...okhslOf(color), chroma: colorToOklch(rgbColor(color.r, color.g, color.b)).c };
}

/**
 * 获取源颜色在另一个 OKHSL 明度下的颜色。源颜色的饱和度适用于其自身明度，并沿色彩系列的饱和度曲线
 * 向黑白两端递减，且不会超过曲线规定的上限。
 *
 * OKHSL 饱和度相对于该明度下 sRGB 所允许的最大色度，因此相同饱和度在其他明度下可能代表更高色度：
 * Catppuccin Frappe 的粉色 #f4b8e4（色度 0.089）在强调色所需的明度下会变为 #eb76d1（色度 0.180）。
 * 因此，色度也会按相同的衰减曲线限制在源颜色的色度以内。
 */
function anchored(source: SourceColor, family: Family, lightness: number, saturation: number): RgbColor {
	const anchor = saturationCurve(family, source.l);
	const falloff = anchor > 0 ? Math.min(1, saturationCurve(family, lightness) / anchor) : 1;
	const color = okhslColor(source.h, source.s * falloff * saturation, lightness);
	const cap = source.chroma * falloff * saturation;
	const { l, c } = colorToOklch(color);
	return c <= cap ? color : colorToRgb(oklchColor(l, cap, source.h));
}

/** 将文本颜色向白色或黑色调整，直到它在所有表面上都达到 WCAG 最低对比度。 */
function withTextContrast(color: RgbColor, surfaces: RgbColor[], lighter: boolean): RgbColor {
	const meets = (candidate: RgbColor) =>
		surfaces.every((surface) => wcagContrast(candidate, surface) >= TEXT_MINIMUM_WCAG_CONTRAST);
	if (meets(color)) return color;
	const { h, s, l } = okhslOf(color);
	const at = (lightness: number) => okhslColor(h, s, lightness);
	const extreme = lighter ? 1 : 0;
	if (!meets(at(extreme))) return at(extreme);
	let [low, high] = [l, extreme];
	for (let index = 0; index < 20; index++) {
		const middle = (low + high) / 2;
		if (meets(at(middle))) high = middle;
		else low = middle;
	}
	return at(high);
}

/**
 * 适用于未报告任何颜色信息的终端：ANSI 索引 0 到 15 以及默认颜色由终端主题自行渲染，因此可适配任意背景。
 * 低于正文级别的中性色标记使用淡化效果（SGR 2），而非亮黑色，避免在某些主题中几乎不可见。面板不设背景色。
 */
function indexedColors(saturation: number, appearance: ThemeAppearance | undefined): SystemThemeColors {
	const colors = {} as Record<ThemeToken, string | number>;
	const dim: ThemeColor[] = [];
	for (const [token, familyName] of Object.entries(TOKEN_FAMILIES) as [ThemeToken, FamilyName][]) {
		if (PANELS.includes(token as ThemeBg)) {
			colors[token] = "";
			continue;
		}
		const neutral = familyName === "neutral";
		colors[token] = !neutral && saturation > 0 ? (TOKEN_SLOTS[token] ?? FAMILIES[familyName].slot) : "";
		if (neutral && !FOREGROUND_TOKENS.includes(token as ThemeColor)) dim.push(token as ThemeColor);
	}
	return { colors, dim, appearance };
}
