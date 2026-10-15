/**
 * 扩展注册工具的包装器。
 *
 * 这些包装器只负责调整工具执行方式，使扩展工具能够接收 runner 上下文。
 * 工具调用和结果拦截由 AgentSession 通过 agent-core 钩子处理。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * 将 RegisteredTool 包装为 AgentTool。
 * 使用 runner 的 createToolContext()，确保工具和事件处理器获得一致的上下文。
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return wrapToolDefinition(registeredTool.definition, (toolCallId, signal) =>
		runner.createToolContext(toolCallId, signal),
	);
}

/**
 * 将所有已注册工具包装为 AgentTool。
 * 使用 runner 的 createToolContext()，确保工具和事件处理器获得一致的上下文。
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
