import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete, getEnvApiKey, getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Message, Tool, ToolCall } from "../src/types.ts";

const testToolSchema = Type.Object({
	value: Type.Number({ description: "A number to double" }),
});

const testTool: Tool<typeof testToolSchema> = {
	name: "double_number",
	description: "Doubles a number and returns the result",
	parameters: testToolSchema,
};

describe.skipIf(!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY)(
	"OpenAI Responses reasoning replay e2e",
	() => {
		it("skips reasoning-only history after an aborted turn", { retry: 2 }, async () => {
			const model = getModel("openai", "gpt-5-mini");

			const apiKey = getEnvApiKey("openai");
			if (!apiKey) {
				throw new Error("Missing OPENAI_API_KEY");
			}

			const userMessage: Message = {
				role: "user",
				content: "Use the double_number tool to double 21.",
				timestamp: Date.now(),
			};

			const assistantResponse = await complete(
				model,
				{
					systemPrompt: "You are a helpful assistant. Use the tool.",
					messages: [userMessage],
					tools: [testTool],
				},
				{
					apiKey,
					reasoningEffort: "high",
				},
			);

			const thinkingBlock = assistantResponse.content.find(
				(block) => block.type === "thinking" && block.thinkingSignature,
			);
			if (!thinkingBlock || thinkingBlock.type !== "thinking") {
				throw new Error("Missing thinking signature from OpenAI Responses");
			}

			const corruptedAssistant: AssistantMessage = {
				...assistantResponse,
				content: [thinkingBlock],
				stopReason: "aborted",
			};

			const followUp: Message = {
				role: "user",
				content: "Say hello to confirm you can continue.",
				timestamp: Date.now(),
			};

			const context: Context = {
				systemPrompt: "You are a helpful assistant.",
				messages: [userMessage, corruptedAssistant, followUp],
				tools: [testTool],
			};

			const response = await complete(model, context, {
				apiKey,
				reasoningEffort: "high",
			});

			// 关键断言：不会因孤立的 reasoning 项而返回 400 错误。
			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(response.errorMessage).toBeFalsy();
			// 模型应返回文本或工具调用。
			expect(response.content.length).toBeGreaterThan(0);
		});

		it("handles same-provider different-model handoff with tool calls", { retry: 2 }, async () => {
			// 此测试覆盖以下场景：
			// 1. 模型 A（gpt-5-mini）生成推理内容和 function_call。
			// 2. 用户切换到模型 B（gpt-5.2-codex），提供商相同但模型不同。
			// 3. transform-messages 检测到 isSameModel=false，并将 thinking 转换为文本。
			// 4. 但工具调用 ID 仍带有 OpenAI 配对历史（fc_xxx 与 rs_xxx 配对）。
			// 5. 修复前：OpenAI 返回 400，提示缺少 function_call 所需的 reasoning 项。
			// 6. 修复后：工具调用和结果会转换为文本，对话可以继续。

			const modelA = getModel("openai", "gpt-5-mini");
			const modelB = getModel("openai", "gpt-5.5");

			const apiKey = getEnvApiKey("openai");
			if (!apiKey) {
				throw new Error("Missing OPENAI_API_KEY");
			}

			const userMessage: Message = {
				role: "user",
				content: "Use the double_number tool to double 21.",
				timestamp: Date.now(),
			};

			// 获取模型 A 返回的真实响应，其中包含推理内容和工具调用。
			const assistantResponse = await complete(
				modelA,
				{
					systemPrompt: "You are a helpful assistant. Always use the tool when asked.",
					messages: [userMessage],
					tools: [testTool],
				},
				{
					apiKey,
					reasoningEffort: "high",
				},
			);

			const toolCallBlock = assistantResponse.content.find((block) => block.type === "toolCall") as
				| ToolCall
				| undefined;

			if (!toolCallBlock) {
				throw new Error("Missing tool call from OpenAI Responses - model did not use the tool");
			}

			// 提供工具执行结果。
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: toolCallBlock.id,
				toolName: toolCallBlock.name,
				content: [{ type: "text", text: "42" }],
				isError: false,
				timestamp: Date.now(),
			};

			const followUp: Message = {
				role: "user",
				content: "What was the result? Answer with just the number.",
				timestamp: Date.now(),
			};

			// 现在切换到模型 B 继续对话（模型不同，提供商相同）。
			const context: Context = {
				systemPrompt: "You are a helpful assistant. Answer concisely.",
				messages: [userMessage, assistantResponse, toolResult, followUp],
				tools: [testTool],
			};

			let capturedPayload: any = null;
			const response = await complete(modelB, context, {
				apiKey,
				reasoningEffort: "high",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});

			// 关键断言：不会因孤立的 function_call 而返回 400 错误。
			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(response.errorMessage).toBeFalsy();
			expect(response.content.length).toBeGreaterThan(0);

			// 记录发送的内容以便调试。
			const input = capturedPayload?.input as any[];
			const functionCalls = input?.filter((item: any) => item.type === "function_call") || [];
			const reasoningItems = input?.filter((item: any) => item.type === "reasoning") || [];

			console.log("Payload sent to API:");
			console.log("- function_calls:", functionCalls.length);
			console.log("- reasoning items:", reasoningItems.length);
			console.log("- full input:", JSON.stringify(input, null, 2));

			// 验证模型理解了上下文。
			const responseText = response.content
				.filter((b) => b.type === "text")
				.map((b) => (b as any).text)
				.join("");
			expect(responseText).toContain("42");
		});

		it("handles cross-provider handoff from Anthropic to OpenAI Codex", { retry: 2 }, async () => {
			// 此测试覆盖跨提供商切换：
			// 1. Anthropic 模型生成 thinking 和 function_call（ID 格式为 toolu_xxx）。
			// 2. 用户切换到 OpenAI Codex。
			// 3. transform-messages 检测到 isSameModel=false，并将 thinking 转换为文本。
			// 4. 工具调用 ID 使用 Anthropic 格式（toolu_xxx），没有 OpenAI 配对历史。
			// 5. 外部提供商的 ID 不要求配对，因此该流程应正常工作。

			const anthropicModel = getModel("anthropic", "claude-sonnet-4-5");
			const codexModel = getModel("openai", "gpt-5.5");

			const anthropicApiKey = getEnvApiKey("anthropic");
			const openaiApiKey = getEnvApiKey("openai");
			if (!anthropicApiKey || !openaiApiKey) {
				throw new Error("Missing API keys");
			}

			const userMessage: Message = {
				role: "user",
				content: "Use the double_number tool to double 21.",
				timestamp: Date.now(),
			};

			// 获取 Anthropic 返回的真实响应，其中包含 thinking 和工具调用。
			const assistantResponse = await complete(
				anthropicModel,
				{
					systemPrompt: "You are a helpful assistant. Always use the tool when asked.",
					messages: [userMessage],
					tools: [testTool],
				},
				{
					apiKey: anthropicApiKey,
					thinkingEnabled: true,
					thinkingBudgetTokens: 5000,
				},
			);

			const toolCallBlock = assistantResponse.content.find((block) => block.type === "toolCall") as
				| ToolCall
				| undefined;

			if (!toolCallBlock) {
				throw new Error("Missing tool call from Anthropic - model did not use the tool");
			}

			console.log("Anthropic tool call ID:", toolCallBlock.id);

			// 提供工具执行结果。
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: toolCallBlock.id,
				toolName: toolCallBlock.name,
				content: [{ type: "text", text: "42" }],
				isError: false,
				timestamp: Date.now(),
			};

			const followUp: Message = {
				role: "user",
				content: "What was the result? Answer with just the number.",
				timestamp: Date.now(),
			};

			// 现在切换到 Codex 继续对话（提供商不同）。
			const context: Context = {
				systemPrompt: "You are a helpful assistant. Answer concisely.",
				messages: [userMessage, assistantResponse, toolResult, followUp],
				tools: [testTool],
			};

			let capturedPayload: any = null;
			const response = await complete(codexModel, context, {
				apiKey: openaiApiKey,
				reasoningEffort: "high",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});

			// 记录发送的内容。
			const input = capturedPayload?.input as any[];
			const functionCalls = input?.filter((item: any) => item.type === "function_call") || [];
			const reasoningItems = input?.filter((item: any) => item.type === "reasoning") || [];

			console.log("Payload sent to Codex:");
			console.log("- function_calls:", functionCalls.length);
			console.log("- reasoning items:", reasoningItems.length);
			if (functionCalls.length > 0) {
				console.log(
					"- function_call IDs:",
					functionCalls.map((fc: any) => fc.id),
				);
			}

			// 关键断言：不会返回 400 错误。
			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(response.errorMessage).toBeFalsy();
			expect(response.content.length).toBeGreaterThan(0);

			// 验证模型理解了上下文。
			const responseText = response.content
				.filter((b) => b.type === "text")
				.map((b) => (b as any).text)
				.join("");
			expect(responseText).toContain("42");
		});
	},
);
