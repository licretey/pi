/**
 * 使用 `@earendil-works/pi-mcp` 和 `@earendil-works/pi-codemode`，为 pi-agent-core 的 `Agent`
 * 提供 MCP 工具和 codemode 工具的适配器。它们的组合方式见 main.ts。
 */

import {
	type Agent,
	type AgentTool,
	type AgentToolCallOutcome,
	type AgentToolResult,
	runToolCall,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, JsonObject, JsonValue, TextContent } from "@earendil-works/pi-ai";
import {
	type CodemodeJsonSchema,
	CodemodeSandbox,
	type CodemodeTool,
	renderDeclarations,
} from "@earendil-works/pi-codemode";
import { type McpClient, toLlmContent } from "@earendil-works/pi-mcp";
import { Type } from "typebox";

/** 提供商工具名称最多 64 个字符，且仅允许 `[A-Za-z0-9_-]` 中的字符。 */
function toToolName(prefix: string, name: string): string {
	return `${prefix}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * 为已连接 MCP 服务器中的每个工具创建一个 `AgentTool`，名称为 `<prefix>_<tool>`。
 * MCP 工具声明了输出 schema 时，会将其设为 `outputSchema` 并返回 `structuredContent`，
 * codemode 脚本会收到该结构化内容，而不是文本。
 */
export async function createMcpTools(client: McpClient, prefix: string): Promise<AgentTool[]> {
	const tools = await client.listTools();
	return tools.map(
		(tool): AgentTool => ({
			name: toToolName(prefix, tool.name),
			label: tool.title ?? tool.name,
			description: tool.description ?? tool.title ?? `MCP tool ${tool.name}`,
			// 提供商要求 schema 为对象类型，且有些提供商会拒绝缺少 `properties` 的 schema。
			parameters: Type.Unsafe({
				...tool.inputSchema,
				type: "object",
				properties: tool.inputSchema.properties ?? {},
			}),
			outputSchema: tool.outputSchema ? Type.Unsafe<Record<string, unknown>>(tool.outputSchema) : undefined,
			execute: async (_toolCallId, params, signal, onUpdate) => {
				const result = await client.callTool(tool.name, params as Record<string, unknown>, {
					signal,
					onProgress: (progress) => {
						const text = progress.message ?? `Progress ${progress.progress}`;
						onUpdate?.({ content: [{ type: "text", text }], details: undefined });
					},
				});
				const content = toLlmContent(result);
				if (result.isError && content.length === 0) {
					content.push({ type: "text", text: `MCP tool ${tool.name} failed` });
				}
				return {
					content,
					details: undefined,
					structuredContent: result.structuredContent as JsonValue | undefined,
					// MCP 将工具失败信息放在结果中返回，而不是作为协议错误报告。
					isError: result.isError === true,
				};
			},
		}),
	);
}

/**
 * 通过智能体的调用流水线代其他工具运行工具调用：参数验证以及智能体的
 * `beforeToolCall`/`afterToolCall` 钩子，均与模型发起的调用相同。
 * 智能体没有钩子时，也可以直接调用 `tool.execute()`。
 */
export function createNestedToolRunner(
	agent: Agent,
): (name: string, args: unknown, signal: AbortSignal) => Promise<AgentToolCallOutcome> {
	let nextId = 1;
	return (name, args, signal) => {
		const assistantMessage = agent.state.messages.findLast((message) => message.role === "assistant");
		if (assistantMessage?.role !== "assistant") throw new Error("Nested tool calls need an assistant message");
		const tools = agent.state.tools;
		return runToolCall(
			{ type: "toolCall", id: `nested-${nextId++}`, name, arguments: (args ?? {}) as JsonObject },
			{
				tools,
				assistantMessage,
				context: { messages: agent.state.messages, tools },
				beforeToolCall: agent.beforeToolCall,
				afterToolCall: agent.afterToolCall,
				signal,
			},
		);
	};
}

export const CODEMODE_TOOL_NAME = "codemode";

const codemodeParameters = Type.Object({
	code: Type.String({ description: "JavaScript source. Top-level await and return work." }),
});

/**
 * 在 codemode 沙箱中运行模型编写的 JavaScript；其中 `tools.<name>(args)` 会调用对应工具。
 * 嵌套调用结果不会进入模型上下文；只有脚本输出和返回值会传回。
 */
export function createCodemodeTool(
	tools: readonly AgentTool[],
	runTool: (name: string, args: unknown, signal: AbortSignal) => Promise<AgentToolCallOutcome>,
): AgentTool<typeof codemodeParameters> {
	const callable = tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
	const sandboxTools: CodemodeTool[] = callable.map((tool) => ({
		name: tool.name,
		description: tool.description,
		// TypeBox schema 使用 JSON Schema 格式。
		inputSchema: tool.parameters as CodemodeJsonSchema,
		// 脚本接收的结果：工具声明了结构化输出时返回该结果，否则返回文本。
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? { type: "string" },
		execute: async (args, { signal }) => {
			const outcome = await runTool(tool.name, args, signal);
			if (tool.outputSchema && outcome.result.structuredContent !== undefined) {
				return outcome.result.structuredContent;
			}
			const text = textOf(outcome.result);
			if (outcome.isError) throw new Error(text || `Tool ${tool.name} failed`);
			return text;
		},
	}));

	return {
		name: CODEMODE_TOOL_NAME,
		label: "Codemode",
		description: [
			"Run JavaScript that calls other tools, to chain calls, run them in parallel, or filter large results.",
			"The code is the body of an async function. There is no Node, file system, network, or timers.",
			"Call tools as `await tools.<name>(args)`. Output with `text(value)` or `console.log()`, or `return` a value.",
			"Only the output and the return value reach you, not the results of the tool calls.",
			"",
			"```ts",
			renderDeclarations({ tools: sandboxTools }),
			"```",
		].join("\n"),
		parameters: codemodeParameters,
		execute: async (_toolCallId, params, signal) => {
			const sandbox = new CodemodeSandbox({ tools: sandboxTools, timeoutMs: 120_000 });
			try {
				const result = await sandbox.execute(params.code, { signal });
				// 按顺序收集 text()、console.* 和 image() 产生的内容项；其结构符合 pi-ai 的内容类型。
				const content: (TextContent | ImageContent)[] = [...result.output];
				if (result.ok && result.value !== undefined) {
					const value = typeof result.value === "string" ? result.value : JSON.stringify(result.value);
					content.push({ type: "text", text: value });
				}
				if (!result.ok) {
					content.push({ type: "text", text: `Script failed: ${result.error.stack ?? result.error.message}` });
				}
				return { content, details: { calls: result.calls }, isError: !result.ok };
			} finally {
				await sandbox.close();
			}
		},
	};
}
