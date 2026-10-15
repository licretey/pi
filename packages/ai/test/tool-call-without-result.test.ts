import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Api, Context, Model, StreamOptions, Tool } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.ts";
import { resolveApiKey } from "./oauth.ts";

// 在模块级别解析 OAuth 令牌（异步执行，先于测试运行）。
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

// 简单的计算工具。
const calculateSchema = Type.Object({
	expression: Type.String({ description: "The mathematical expression to evaluate" }),
});

const calculateTool: Tool = {
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
};

async function testToolCallWithoutResult<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// 第一步：创建包含 calculate 工具的上下文。
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Use the calculate tool when asked to perform calculations.",
		messages: [],
		tools: [calculateTool],
	};

	// 第二步：请求 LLM 调用工具。
	context.messages.push({
		role: "user",
		content: "Please calculate 25 * 18 using the calculate tool.",
		timestamp: Date.now(),
	});

	// 第三步：获取 assistant 响应（其中应包含工具调用）。
	const firstResponse = await complete(model, context, options);
	context.messages.push(firstResponse);

	console.log("First response:", JSON.stringify(firstResponse, null, 2));

	// 验证响应中包含工具调用。
	const hasToolCall = firstResponse.content.some((block) => block.type === "toolCall");
	expect(hasToolCall).toBe(true);

	if (!hasToolCall) {
		throw new Error("Expected assistant to make a tool call, but none was found");
	}

	// 第四步：发送用户消息，但不提供工具结果。
	// 这模拟工具调用被中止或取消的情况。
	context.messages.push({
		role: "user",
		content: "Never mind, just tell me what is 2+2?",
		timestamp: Date.now(),
	});

	// 第五步：修复应过滤孤立的工具调用，并使请求成功。
	const secondResponse = await complete(model, context, options);
	console.log("Second response:", JSON.stringify(secondResponse, null, 2));

	// 请求应成功而不是报错，这是本测试的主要验证目标。
	expect(secondResponse.stopReason).not.toBe("error");

	// 响应中应包含一些内容。
	expect(secondResponse.content.length).toBeGreaterThan(0);

	// LLM 可以直接回答，也可以再次调用工具，两种情况都可以。
	// 关键是不能因孤立工具调用而失败。
	const textContent = secondResponse.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join(" ");
	const toolCalls = secondResponse.content.filter((block) => block.type === "toolCall").length;
	expect(toolCalls || textContent.length).toBeGreaterThan(0);
	console.log("Answer:", textContent);

	// 验证停止原因为 "stop" 或 "toolUse"（表示模型停止生成或发起了新的工具调用）。
	expect(["stop", "toolUse"]).toContain(secondResponse.stopReason);
}

describe("Tool Call Without Result Tests", () => {
	// =========================================================================
	// 使用 API 密钥的提供商。
	// =========================================================================

	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider", () => {
		const model = getModel("google", "gemini-2.5-flash");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		void _compat;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider", () => {
		const model = getModel("openai", "gpt-5-mini");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider", () => {
		const model = getModel("azure", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(model.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider", () => {
		const model = getModel("xai", "grok-4.3");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider", () => {
		const model = getModel("groq", "openai/gpt-oss-20b");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider", () => {
		const model = getModel("cerebras", "gpt-oss-120b");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI Provider", () => {
		const model = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!hasCloudflareAiGatewayCredentials())("Cloudflare AI Gateway Provider", () => {
		const model = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider", () => {
		const model = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.TOGETHER_API_KEY)("Together AI Provider", () => {
		const model = getModel("together", "moonshotai/Kimi-K3");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model, { reasoningEffort: "high" });
		});
	});

	describe.skipIf(!process.env.BASETEN_API_KEY)("Baseten Provider", () => {
		const model = getModel("baseten", "zai-org/GLM-5.2");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model, { reasoningEffort: "high" });
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider", () => {
		const model = getModel("zai", "glm-5.2");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider", () => {
		const model = getModel("mistral", "devstral-medium-latest");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider", () => {
		const model = getModel("minimax", "MiniMax-M2.7");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider", () => {
		const model = getModel("xiaomi", "mimo-v2.5-pro");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)("Xiaomi MiMo Token Plan (CN) Provider", () => {
		const model = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)("Xiaomi MiMo Token Plan (AMS) Provider", () => {
		const model = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)("Xiaomi MiMo Token Plan (SGP) Provider", () => {
		const model = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)("Qwen Token Plan Provider", () => {
		const model = getModel("qwen-token-plan", "qwen3.7-max");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)("Qwen Token Plan Individual Provider", () => {
		const model = getModel("qwen-token-plan-individual", "qwen3.8-max");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_CN_API_KEY)("Qwen Token Plan (CN) Provider", () => {
		const model = getModel("qwen-token-plan-cn", "qwen3.7-max");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider", () => {
		const model = getModel("kimi-coding", "kimi-for-coding");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider", () => {
		const model = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider", () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	// =========================================================================
	// 使用 OAuth 的提供商（凭据保存在 ~/.pi/agent/oauth.json）。
	// =========================================================================

	describe("Anthropic OAuth Provider", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it.skipIf(!anthropicOAuthToken)(
			"should filter out tool calls without corresponding tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testToolCallWithoutResult(model, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"claude-haiku-4.5 - should filter out tool calls without corresponding tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = getModel("github-copilot", "claude-haiku-4.5");
				await testToolCallWithoutResult(model, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should filter out tool calls without corresponding tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = getModel("github-copilot", "claude-sonnet-4.6");
				await testToolCallWithoutResult(model, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should filter out tool calls without corresponding tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = getModel("openai-codex", "gpt-5.5");
				await testToolCallWithoutResult(model, { apiKey: openaiCodexToken });
			},
		);
	});
});
