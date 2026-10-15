import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions, ToolResultMessage } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.ts";
import { resolveApiKey } from "./oauth.ts";

// 测试工具使用的空架构必须是有效的 OBJECT 类型，Cloud Code Assist 才能接受。
const emptySchema = Type.Object({});

// 在模块级别解析 OAuth 令牌（异步执行，先于测试运行）。
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

/**
 * 测试工具结果中的 Unicode 代理项对处理。
 *
 * 问题：工具结果包含表情符号或其他基本多文种平面之外的字符时，
 * 可能会被错误地序列化为不成对的代理项，发送给 API 提供商后导致 "no low surrogate in string" 错误。
 *
 * Anthropic 返回的错误示例：
 * "The request body is not valid JSON: no low surrogate in string: line 1 column 197667"
 */

async function testEmojiInToolResults<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "testtool1" : "test_1";
	// 模拟返回表情符号的工具。
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// 添加包含多种问题 Unicode 字符的工具结果。
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [
			{
				type: "text",
				text: `Test with emoji 🙈 and other characters:
- Monkey emoji: 🙈
- Thumbs up: 👍
- Heart: ❤️
- Thinking face: 🤔
- Rocket: 🚀
- Mixed text: Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈
- Japanese: こんにちは
- Chinese: 你好
- Mathematical symbols: ∑∫∂√
- Special quotes: "curly" 'quotes'`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// 添加后续用户消息。
	context.messages.push({
		role: "user",
		content: "Summarize the tool result briefly.",
		timestamp: Date.now(),
	});

	// 此处不应因代理项对问题而抛出错误。
	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

async function testRealWorldLinkedInData<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "linkedin1" : "linkedin_1";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the linkedin tool to get comments",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "linkedin_skill",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "linkedin_skill",
				description: "Get LinkedIn comments",
				parameters: emptySchema,
			},
		],
	};

	// 来自 LinkedIn、包含表情符号的真实工具结果。
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "linkedin_skill",
		content: [
			{
				type: "text",
				text: `Post: Hab einen "Generative KI für Nicht-Techniker" Workshop gebaut.
Unanswered Comments: 2

=> {
  "comments": [
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Leider nehmen das viel zu wenige Leute ernst"
    },
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈"
    }
  ]
}`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "How many comments are there?",
		timestamp: Date.now(),
	});

	// 此处不应因代理项对问题而抛出错误。
	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.some((b) => b.type === "text")).toBe(true);
}

async function testUnpairedHighSurrogate<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "testtool2" : "test_2";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// 构造一个故意不成对的高位代理项字符串。
	// 用于模拟文本处理过程破坏表情符号的情况。
	const unpairedSurrogate = String.fromCharCode(0xd83d); // 没有对应低位代理项的高位代理项

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [{ type: "text", text: `Text with unpaired surrogate: ${unpairedSurrogate} <- should be sanitized` }],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "What did the tool return?",
		timestamp: Date.now(),
	});

	// 此处不应因代理项对问题而抛出错误。
	// 不成对的代理项应在发送给 API 前完成清理。
	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

describe("AI Providers Unicode Surrogate Pair Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Unicode Handling", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Unicode Handling", () => {
		const llm = getModel("openai", "gpt-4o-mini");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Unicode Handling", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider Unicode Handling", () => {
		const llm = getModel("azure", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm, azureOptions);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm, azureOptions);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider Unicode Handling", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	// =========================================================================
	// 使用 OAuth 的提供商（凭据来自 ~/.pi/agent/oauth.json）。
	// =========================================================================

	describe("Anthropic OAuth Provider Unicode Handling", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it.skipIf(!anthropicOAuthToken)("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)(
			"should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testRealWorldLinkedInData(llm, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testUnpairedHighSurrogate(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider Unicode Handling", () => {
		it.skipIf(!githubCopilotToken)(
			"claude-haiku-4.5 - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-haiku-4.5");
				await testEmojiInToolResults(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-haiku-4.5 - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-haiku-4.5");
				await testRealWorldLinkedInData(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-haiku-4.5 - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-haiku-4.5");
				await testUnpairedHighSurrogate(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await testEmojiInToolResults(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await testRealWorldLinkedInData(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await testUnpairedHighSurrogate(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider Unicode Handling", () => {
		const llm = getModel("xai", "grok-4.3");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider Unicode Handling", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider Unicode Handling", () => {
		const llm = getModel("cerebras", "gpt-oss-120b");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI Provider Unicode Handling", () => {
		const llm = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!hasCloudflareAiGatewayCredentials())("Cloudflare AI Gateway Provider Unicode Handling", () => {
		const llm = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider Unicode Handling", () => {
		const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.TOGETHER_API_KEY)("Together AI Provider Unicode Handling", () => {
		const llm = getModel("together", "moonshotai/Kimi-K3");
		const options = { reasoningEffort: "high" } satisfies StreamOptionsWithExtras;

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm, options);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm, options);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm, options);
		});
	});

	describe.skipIf(!process.env.BASETEN_API_KEY)("Baseten Provider Unicode Handling", () => {
		const llm = getModel("baseten", "zai-org/GLM-5.2");
		const options = { reasoningEffort: "high" } satisfies StreamOptionsWithExtras;

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm, options);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm, options);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm, options);
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider Unicode Handling", () => {
		const llm = getModel("zai", "glm-5.2");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider Unicode Handling", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider Unicode Handling", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider Unicode Handling", () => {
		const llm = getModel("xiaomi", "mimo-v2.5-pro");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)(
		"Xiaomi MiMo Token Plan (CN) Provider Unicode Handling",
		() => {
			const llm = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

			it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
				await testEmojiInToolResults(llm);
			});

			it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
				await testRealWorldLinkedInData(llm);
			});

			it(
				"should handle unpaired high surrogate (0xD83D) in tool results",
				{ retry: 3, timeout: 30000 },
				async () => {
					await testUnpairedHighSurrogate(llm);
				},
			);
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)(
		"Xiaomi MiMo Token Plan (AMS) Provider Unicode Handling",
		() => {
			const llm = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

			it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
				await testEmojiInToolResults(llm);
			});

			it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
				await testRealWorldLinkedInData(llm);
			});

			it(
				"should handle unpaired high surrogate (0xD83D) in tool results",
				{ retry: 3, timeout: 30000 },
				async () => {
					await testUnpairedHighSurrogate(llm);
				},
			);
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)(
		"Xiaomi MiMo Token Plan (SGP) Provider Unicode Handling",
		() => {
			const llm = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

			it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
				await testEmojiInToolResults(llm);
			});

			it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
				await testRealWorldLinkedInData(llm);
			});

			it(
				"should handle unpaired high surrogate (0xD83D) in tool results",
				{ retry: 3, timeout: 30000 },
				async () => {
					await testUnpairedHighSurrogate(llm);
				},
			);
		},
	);

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)("Qwen Token Plan Provider Unicode Handling", () => {
		const llm = getModel("qwen-token-plan", "qwen3.7-max");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)("Qwen Token Plan Individual Provider Unicode Handling", () => {
		const llm = getModel("qwen-token-plan-individual", "qwen3.8-max");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_CN_API_KEY)("Qwen Token Plan (CN) Provider Unicode Handling", () => {
		const llm = getModel("qwen-token-plan-cn", "qwen3.7-max");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider Unicode Handling", () => {
		const llm = getModel("kimi-coding", "kimi-for-coding");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider Unicode Handling", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider Unicode Handling", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe("OpenAI Codex Provider Unicode Handling", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await testEmojiInToolResults(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await testRealWorldLinkedInData(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await testUnpairedHighSurrogate(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});
