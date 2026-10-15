/**
 * 主题 JSON 校验逻辑，特意与 `theme.ts` 分开。
 *
 * 校验用户编写的主题文件需要导入 typebox，会增加约 17 MB 的模块依赖图。
 * 调色板查询不需要 typebox，因此只使用内置主题的界面不应承担这项开销。
 * `main.ts` 会在加载运行时资源前注册此校验器；其他调用方可以通过 `setThemeJsonValidator()` 选择启用。
 * 内置主题无需校验。
 */

import { type Static, type TProperties, Type } from "typebox";
import { Compile } from "typebox/compile";
import { THEME_TOKENS, type ThemeColorValues, type ThemeTokenDescriptors } from "./theme-tokens.ts";

function colorValue(description?: string) {
	return Type.Union(
		[
			Type.String({
				description:
					"Hex color (#RGB or #RRGGBB), OKLCH or OKHSL color, variable reference, or empty string for terminal default",
			}),
			Type.Integer({
				minimum: 0,
				maximum: 255,
				description: "256-color palette index (0-255)",
			}),
		],
		description ? { description } : {},
	);
}

export const ColorValueSchema = colorValue();

export type ThemeColorValue = Static<typeof ColorValueSchema>;

function themeTokenProperties(tokens: ThemeTokenDescriptors): TProperties {
	const properties: TProperties = {};
	for (const [name, descriptor] of Object.entries(tokens)) {
		const schema = colorValue(descriptor.description);
		properties[name] = descriptor.fallback === undefined ? schema : Type.Optional(schema);
	}
	return properties;
}

const ThemeColorsSchema = Type.Unsafe<ThemeColorValues<ThemeColorValue>>(
	Type.Object(themeTokenProperties(THEME_TOKENS), {
		description:
			"Theme color definitions (scrollbar, thinkingMax, and search highlight colors are optional and use compatible fallbacks)",
		additionalProperties: false,
	}),
);

export const ThemeJsonSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON schema reference" })),
		name: Type.String({
			pattern: "^[^/]+$",
			description:
				"Theme name. Must not contain '/' because it is reserved for automatic light/dark theme settings.",
		}),
		appearance: Type.Optional(
			Type.Union([Type.Literal("dark"), Type.Literal("light")], {
				description: "Background the theme is designed for. Detected from the theme colors when omitted.",
			}),
		),
		vars: Type.Optional(
			Type.Record(Type.String(), ColorValueSchema, {
				description: "Reusable color variables",
			}),
		),
		colors: ThemeColorsSchema,
		export: Type.Optional(
			Type.Object(
				{
					pageBg: Type.Optional(colorValue("Page background color")),
					cardBg: Type.Optional(colorValue("Card/container background color")),
					infoBg: Type.Optional(colorValue("Info sections background (system prompt, notices)")),
				},
				{
					description: "Optional colors for HTML export (defaults derived from userMessageBg if not specified)",
					additionalProperties: false,
				},
			),
		),
	},
	{
		title: "Pi Coding Agent Theme",
		description: "Theme schema for Pi coding agent",
		additionalProperties: false,
	},
);

const compiledThemeSchema = Compile(ThemeJsonSchema);

export type ValidatedThemeJson = Static<typeof ThemeJsonSchema>;

/** 校验单个主题文档；校验失败时抛出包含问题 token 名称的错误。 */
export function validateThemeJson(label: string, json: unknown): ValidatedThemeJson {
	if (
		typeof json === "object" &&
		json !== null &&
		"name" in json &&
		typeof json.name === "string" &&
		json.name.includes("/")
	) {
		throw new Error(
			`Invalid theme name "${json.name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}

	if (!compiledThemeSchema.Check(json)) {
		const errors = Array.from(compiledThemeSchema.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	return json as ValidatedThemeJson;
}
