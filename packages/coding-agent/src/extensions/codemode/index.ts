/**
 * 以扩展形式提供的 `codemode` 工具。CLI 会将其作为内置扩展加载；SDK 用户可将
 * `createCodemodeExtension()` 添加到扩展工厂中。
 *
 * `codemode` 注册时默认不启用。可通过 `--tools`、`defaultTools` 设置或 `setActiveTools()` 启用；
 * 当 MCP 工具只能通过脚本访问时，MCP 扩展会自动启用它。
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { createCodemodeToolDefinition } from "./tool.ts";

export interface CodemodeExtensionOptions {
	/** 覆盖 `codemode.mode` 设置。 */
	mode?: CodemodeMode;
	/** 覆盖 `codemode.inlineBudget` 设置。 */
	inlineBudget?: number;
	/** 是否通过 `models` 向脚本开放模型目录和分类器。默认值：`true`。 */
	models?: boolean;
}

function readMode(pi: ExtensionAPI): CodemodeMode {
	return pi.getSettings().codemode?.mode === "only" ? "only" : SETTINGS_DEFAULTS.codemode.mode;
}

function readInlineBudget(pi: ExtensionAPI): number | undefined {
	const budget = pi.getSettings().codemode?.inlineBudget;
	return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined;
}

export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			...createCodemodeToolDefinition({
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				models: options.models ?? true,
				getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
				getToolGuidelines: () =>
					new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []] as const)),
				getMode: () => options.mode ?? readMode(pi),
				getInlineBudget: () => options.inlineBudget ?? readInlineBudget(pi),
			}),
			defaultActive: false,
		});
	};
}

export default createCodemodeExtension();
