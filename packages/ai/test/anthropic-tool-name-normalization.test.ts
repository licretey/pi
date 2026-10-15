import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel, stream } from "../src/compat.ts";
import type { Context, Tool } from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

const oauthToken = await resolveApiKey("anthropic");

/**
 * 测试 Anthropic OAuth 工具名称的规范化。
 *
 * 使用 Claude Code OAuth 时，工具名称必须与 CC 的规范大小写一致。
 * 规范化应完成以下操作：
 * 1. 发送请求时，将与 CC 工具名称匹配的名称（不区分大小写）转换为 CC 的大小写形式。
 * 2. 收到响应时，将工具名称还原为原始大小写形式。
 *
 * 这里只进行简单的不区分大小写查找，不会将一个名称映射为另一个不同名称。
 * 例如："todowrite" -> "TodoWrite" -> "todowrite"（往返转换正常）。
 *
 * 旧版 `find -> Glob` 映射是错误的，原因如下：
 * - 发送时："find" -> "Glob"。
 * - 接收时："Glob" -> ???（context.tools 中没有名为 "glob" 的工具，只有 "find"）。
 * - 结果：工具调用名称为 "Glob"，但不存在同名工具。
 */
describe.skipIf(!oauthToken)("Anthropic OAuth tool name normalization", () => {
	const model = getModel("anthropic", "claude-sonnet-4-6");

	it("should normalize user-defined tool matching CC name (todowrite -> TodoWrite -> todowrite)", async () => {
		// 用户定义的工具名为小写的 "todowrite"。
		// CC 中的名称是 "TodoWrite"，往返转换后应恢复原名称。
		const todoTool: Tool = {
			name: "todowrite",
			description: "Write a todo item",
			parameters: Type.Object({
				task: Type.String({ description: "The task to add" }),
			}),
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant. Use the todowrite tool when asked to add todos.",
			messages: [
				{
					role: "user",
					content: "Add a todo: buy milk. Use the todowrite tool.",
					timestamp: Date.now(),
				},
			],
			tools: [todoTool],
		};

		const s = stream(model, context, { apiKey: oauthToken });
		let toolCallName: string | undefined;

		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const toolCall = event.partial.content[event.contentIndex];
				if (toolCall.type === "toolCall") {
					toolCallName = toolCall.name;
				}
			}
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");

		// 返回的工具调用应使用原始名称 "todowrite"，而不是 "TodoWrite"。
		expect(toolCallName).toBe("todowrite");
	});

	it("should handle pi's built-in tools (read, write, edit, bash)", async () => {
		// Pi 的工具名称使用小写形式，CC 使用帕斯卡命名法。
		const readTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: Type.Object({
				path: Type.String({ description: "File path" }),
			}),
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant. Use the read tool to read files.",
			messages: [
				{
					role: "user",
					content: "Read the file /tmp/test.txt using the read tool.",
					timestamp: Date.now(),
				},
			],
			tools: [readTool],
		};

		const s = stream(model, context, { apiKey: oauthToken });
		let toolCallName: string | undefined;

		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const toolCall = event.partial.content[event.contentIndex];
				if (toolCall.type === "toolCall") {
					toolCallName = toolCall.name;
				}
			}
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");

		// 返回的工具调用应使用原始名称 "read"，而不是 "Read"。
		expect(toolCallName).toBe("read");
	});

	it("should NOT map find to Glob - find is not a CC tool name", async () => {
		// Pi 有名为 "find" 的工具，CC 有名为 "Glob" 的工具，两者并不是同一个工具。
		// 旧代码错误地将 find 映射为 Glob，导致往返转换失败，
		// 因为 context.tools 中不存在名为 "glob" 的工具。
		const findTool: Tool = {
			name: "find",
			description: "Find files by pattern",
			parameters: Type.Object({
				pattern: Type.String({ description: "Glob pattern" }),
			}),
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant. Use the find tool to search for files.",
			messages: [
				{
					role: "user",
					content: "Find all .ts files using the find tool.",
					timestamp: Date.now(),
				},
			],
			tools: [findTool],
		};

		const s = stream(model, context, { apiKey: oauthToken });
		let toolCallName: string | undefined;

		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const toolCall = event.partial.content[event.contentIndex];
				if (toolCall.type === "toolCall") {
					toolCallName = toolCall.name;
				}
			}
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");

		// 如果使用错误的 find -> Glob 映射：
		// - 发送给 Anthropic 的名称是 "Glob"。
		// - 收到的名称也是 "Glob"。
		// - fromClaudeCodeName("Glob", tools) 会查找 tool.name.toLowerCase() === "glob"。
		// - 查找不到（工具实际名为 "find"），于是返回 "Glob"。
		// - 测试失败：toolCallName 是 "Glob"，而不是 "find"。
		//
		// 使用正确实现（不进行 find->Glob 映射）时：
		// - 发送给 Anthropic 的名称是 "find"（CC 中没有名为 "Find" 的工具）。
		// - 收到的名称也是 "find"。
		// - 测试通过：toolCallName 为 "find"。
		expect(toolCallName).toBe("find");
	});

	it("should handle custom tools that don't match any CC tool names", async () => {
		// 完全自定义的工具名称应原样透传。
		const customTool: Tool = {
			name: "my_custom_tool",
			description: "A custom tool",
			parameters: Type.Object({
				input: Type.String({ description: "Input value" }),
			}),
		};

		const context: Context = {
			systemPrompt: "You are a helpful assistant. Use my_custom_tool when asked.",
			messages: [
				{
					role: "user",
					content: "Use my_custom_tool with input 'hello'.",
					timestamp: Date.now(),
				},
			],
			tools: [customTool],
		};

		const s = stream(model, context, { apiKey: oauthToken });
		let toolCallName: string | undefined;

		for await (const event of s) {
			if (event.type === "toolcall_end") {
				const toolCall = event.partial.content[event.contentIndex];
				if (toolCall.type === "toolCall") {
					toolCallName = toolCall.name;
				}
			}
		}

		const response = await s.result();
		expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("toolUse");

		// 自定义工具名称应原样透传。
		expect(toolCallName).toBe("my_custom_tool");
	});
});
