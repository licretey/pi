import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { AnyTask, Extension, HookRegistration, HooksOf, PromptSection, ToolRegistration, Wrap } from "./types.ts";

/** 为扩展提供类型的恒等函数。 */
export function defineExtension<Tool extends ToolRegistration = ToolRegistration>(
	extension: Extension<Tool>,
): Extension<Tool> {
	return extension;
}

/** 为工具提供类型的恒等函数：`args` 来自 `parameters`，details 来自它所上报的内容。 */
export function defineTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>(
	tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration<TParameters, TDetails> {
	return tool;
}

/** 一个 prompt section；除 `tag` 为 false 外都会加标记。 */
export function section<Tool extends ToolRegistration = ToolRegistration>(
	key: string,
	render: PromptSection<Tool>["render"],
	options?: { readonly tag?: boolean },
): PromptSection<Tool> {
	return options?.tag === undefined ? { key, render } : { key, render, tag: options.tag };
}

/** 为名称与 `task` 相同的任务提供钩子处理器。 */
export function hook<K extends AnyTask>(task: K, handlers: Partial<HooksOf<K>>): HookRegistration {
	return { task: task.definition.name, handlers };
}

/** 在包装（wrap）扩展被选中的任何地方，包装与 `tool` 同名的工具。 */
export function wrapTool<Tool extends ToolRegistration>(tool: Tool, wrapper: (tool: Tool) => Tool): Wrap<Tool> {
	return { tool: tool.name, wrap: wrapper };
}

/** 在包装（wrap）扩展被选中的任何地方，包装名为 `key` 的 section。 */
export function wrapSection<Tool extends ToolRegistration = ToolRegistration>(
	key: string,
	wrapper: (section: PromptSection<Tool>) => PromptSection<Tool>,
): Wrap<Tool> {
	return { section: key, wrap: wrapper };
}
