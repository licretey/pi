import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";

/** 为单次工具调用创建上下文。 */
export type ToolContextFactory = (toolCallId: string, signal: AbortSignal | undefined) => ExtensionToolContext;

/** 将 ToolDefinition 包装为核心运行时使用的 AgentTool。 */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: ToolContextFactory,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		outputSchema: definition.outputSchema,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionToolContext) =>
			definition.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx ?? (ctxFactory?.(toolCallId, signal) as ExtensionToolContext),
			),
	};
}

/** 将多个 ToolDefinition 包装为核心运行时使用的 AgentTool。 */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: ToolContextFactory,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * 根据 AgentTool 生成最简 ToolDefinition。
 *
 * 即使调用方提供的 AgentTool 覆盖项不含提示元数据或渲染器，
 * 也能让 AgentSession 的内部注册表继续以定义为准。
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		outputSchema: tool.outputSchema,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
