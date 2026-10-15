/**
 * 内置工具的渲染器，不包含工具本身。
 *
 * 展示层负责显示工具调用和结果，不执行工具，因此不需要加载 TypeBox 参数 schema。
 * 只负责渲染的进程应导入本模块而非 `core/tools/index.ts`，从而避免加载约 17 MB 的模块依赖图。
 */

import type { ToolRenderers } from "../../extensions/types.ts";
import type { ToolName } from "../index.ts";
import { createShellRenderers } from "./bash.ts";
import { editRenderers } from "./edit.ts";
import { findRenderers } from "./find.ts";
import { grepRenderers } from "./grep.ts";
import { lsRenderers } from "./ls.ts";
import { readRenderers } from "./read.ts";
import { writeRenderers } from "./write.ts";

export type { ToolRenderers };

export {
	createShellRenderers,
	editRenderers,
	findRenderers,
	grepRenderers,
	lsRenderers,
	readRenderers,
	writeRenderers,
};

/** 所有内置工具的渲染器，以工具名称为键。 */
export function createAllToolRenderers(): Record<ToolName, ToolRenderers> {
	return {
		read: readRenderers,
		bash: createShellRenderers("$"),
		powershell: createShellRenderers("PS>"),
		edit: editRenderers,
		write: writeRenderers,
		grep: grepRenderers,
		find: findRenderers,
		ls: lsRenderers,
	};
}

/**
 * 将内置渲染器合并到未提供自有渲染器的工具定义中。
 *
 * 过去由 `ToolExecutionComponent` 自行查找渲染器，这会迫使每个展示层都导入工具实现。
 * 现在由调用方完成查找，因此仅负责渲染的进程可以只导入渲染器。
 */
export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
	toolName: string,
	definition: TDefinition | undefined,
): TDefinition | ToolRenderers | undefined {
	const builtIn = createAllToolRenderers()[toolName as ToolName];
	if (!definition) return builtIn;
	if (!builtIn) return definition;
	return {
		...definition,
		renderCall: definition.renderCall ?? builtIn.renderCall,
		renderResult: definition.renderResult ?? builtIn.renderResult,
	};
}
