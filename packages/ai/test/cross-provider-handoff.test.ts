/**
 * 跨提供方交接测试。
 *
 * 测试一个提供方/模型生成的上下文是否可供另一个提供方/模型使用。
 * 此测试用于发现以下问题：
 * - 工具调用 ID 格式不兼容（例如 OpenAI Codex 使用竖线）。
 * - 思考内容块转换异常。
 * - 消息格式不兼容。
 *
 * 测试策略：
 * 1. 在 beforeAll 中为每个提供方/模型生成一份“小型上下文”（若缓存中没有）：
 *    - 要求使用工具的用户消息。
 *    - 包含思考内容和工具调用的助手响应。
 *    - 工具结果。
 *    - 助手最终响应。
 *
 * 2. 测试阶段针对每个目标提供方/模型：
 *    - 将其他所有上下文拼接为一个上下文。
 *    - 要求模型“打个招呼”。
 *    - 如果失败，则存在兼容性问题。
 *
 * 每次运行都会重新生成测试数据。
 */

import { writeFileSync } from "fs";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import { completeSimple, getEnvApiKey, getModel } from "../src/compat.ts";
import type { Api, AssistantMessage, Message, Model, Tool, ToolResultMessage } from "../src/types.ts";
import { hasAzureOpenAICredentials } from "./azure-utils.ts";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.ts";
import { resolveApiKey } from "./oauth.ts";

// 用于测试的简单工具。
const testToolSchema = Type.Object({
	value: Type.Number({ description: "A number to double" }),
});

const testTool: Tool<typeof testToolSchema> = {
	name: "double_number",
	description: "Doubles a number and returns the result",
	parameters: testToolSchema,
};

// 要测试的提供方/模型组合。
interface ProviderModelPair {
	provider: string;
	model: string;
	label: string;
	apiOverride?: Api;
	upstreamApiKeyEnv?: string;
}

const PROVIDER_MODEL_PAIRS: ProviderModelPair[] = [
	// Anthropic。
	{ provider: "anthropic", model: "claude-sonnet-4-5", label: "anthropic-claude-sonnet-4-5" },
	// Google。
	{ provider: "google", model: "gemini-3-flash-preview", label: "google-gemini-3-flash-preview" },
	// OpenAI。
	{
		provider: "openai",
		model: "gpt-4o-mini",
		label: "openai-completions-gpt-4o-mini",
		apiOverride: "openai-completions",
	},
	{ provider: "openai", model: "gpt-5-mini", label: "openai-responses-gpt-5-mini" },
	{ provider: "azure", model: "gpt-4o-mini", label: "azure-gpt-4o-mini" },
	// OpenAI Codex。
	{ provider: "openai-codex", model: "gpt-5.5", label: "openai-codex-gpt-5.5" },
	// GitHub Copilot。
	{ provider: "github-copilot", model: "claude-sonnet-4.5", label: "copilot-claude-sonnet-4.5" },
	{ provider: "github-copilot", model: "gpt-5.1-codex", label: "copilot-gpt-5.1-codex" },
	{ provider: "github-copilot", model: "gemini-3-flash-preview", label: "copilot-gemini-3-flash-preview" },
	{ provider: "github-copilot", model: "grok-code-fast-1", label: "copilot-grok-code-fast-1" },
	// Amazon Bedrock。
	{
		provider: "amazon-bedrock",
		model: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
		label: "bedrock-claude-sonnet-4-5",
	},
	// xAI 提供方。
	{ provider: "xai", model: "grok-4.3", label: "xai-grok-4.3" },
	// Cerebras 提供方。
	{ provider: "cerebras", model: "zai-glm-4.7", label: "cerebras-zai-glm-4.7" },
	// Cloudflare Workers AI。
	{ provider: "cloudflare-workers-ai", model: "@cf/moonshotai/kimi-k2.6", label: "cloudflare-kimi-k2.6" },
	// Cloudflare AI Gateway。
	{
		provider: "cloudflare-ai-gateway",
		model: "workers-ai/@cf/moonshotai/kimi-k2.6",
		label: "cloudflare-gateway-kimi-k2.6",
	},
	{
		provider: "cloudflare-ai-gateway",
		model: "claude-sonnet-4-5",
		label: "cloudflare-gateway-claude-sonnet-4-5",
		upstreamApiKeyEnv: "ANTHROPIC_API_KEY",
	},
	{
		provider: "cloudflare-ai-gateway",
		model: "gpt-5.1",
		label: "cloudflare-gateway-gpt-5.1",
		upstreamApiKeyEnv: "OPENAI_API_KEY",
	},
	// Groq 提供方。
	{ provider: "groq", model: "openai/gpt-oss-120b", label: "groq-gpt-oss-120b" },
	// Hugging Face。
	{ provider: "huggingface", model: "moonshotai/Kimi-K2.5", label: "huggingface-kimi-k2.5" },
	// Together AI。
	{ provider: "together", model: "moonshotai/Kimi-K3", label: "together-kimi-k3" },
	// Baseten 提供方。
	{ provider: "baseten", model: "zai-org/GLM-5.2", label: "baseten-glm-5.2" },
	// Kimi For Coding。
	{ provider: "kimi-coding", model: "kimi-for-coding", label: "kimi-for-coding" },
	// Meta 提供方。
	{ provider: "meta", model: "muse-spark-1.3", label: "meta-muse-spark-1.3" },
	// Mistral 提供方。
	{ provider: "mistral", model: "devstral-medium-latest", label: "mistral-devstral-medium" },
	// MiniMax 提供方。
	{ provider: "minimax", model: "MiniMax-M2.7", label: "minimax-m2.7" },
	{ provider: "minimax-cn", model: "MiniMax-M2.7", label: "minimax-m2.7" },
	// OpenCode Zen。
	{ provider: "opencode", model: "big-pickle", label: "zen-big-pickle" },
	{ provider: "opencode", model: "claude-sonnet-4-5", label: "zen-claude-sonnet-4-5" },
	{ provider: "opencode", model: "gemini-3-flash", label: "zen-gemini-3-flash" },
	{ provider: "opencode", model: "glm-4.7-free", label: "zen-glm-4.7-free" },
	{ provider: "opencode", model: "gpt-5.2-codex", label: "zen-gpt-5.2-codex" },
	{ provider: "opencode", model: "minimax-m2.1-free", label: "zen-minimax-m2.1-free" },
	// OpenCode Go。
	{ provider: "opencode-go", model: "kimi-k2.5", label: "go-kimi-k2.5" },
	{ provider: "opencode-go", model: "minimax-m2.5", label: "go-minimax-m2.5" },
	// Xiaomi MiMo。
	{ provider: "xiaomi", model: "mimo-v2.5-pro", label: "xiaomi-mimo-v2.5-pro" },
	{ provider: "xiaomi-token-plan-cn", model: "mimo-v2.5-pro", label: "xiaomi-token-plan-cn-mimo-v2.5-pro" },
	{ provider: "xiaomi-token-plan-ams", model: "mimo-v2.5-pro", label: "xiaomi-token-plan-ams-mimo-v2.5-pro" },
	{ provider: "xiaomi-token-plan-sgp", model: "mimo-v2.5-pro", label: "xiaomi-token-plan-sgp-mimo-v2.5-pro" },
	// Qwen Token Plan。
	{ provider: "qwen-token-plan", model: "qwen3.7-max", label: "qwen-token-plan-qwen3.7-max" },
	{ provider: "qwen-token-plan-cn", model: "qwen3.7-max", label: "qwen-token-plan-cn-qwen3.7-max" },
	{
		provider: "qwen-token-plan-individual",
		model: "qwen3.8-max",
		label: "qwen-token-plan-individual-qwen3.8-max",
	},
	{
		provider: "qwen-token-plan-individual",
		model: "deepseek-v4-flash-0731",
		label: "qwen-token-plan-individual-deepseek-v4-flash-0731",
	},
	{
		provider: "qwen-token-plan-individual",
		model: "glm-5.2",
		label: "qwen-token-plan-individual-glm-5.2",
	},
];

// 缓存上下文的结构。
interface CachedContext {
	label: string;
	provider: string;
	model: string;
	api: Api;
	messages: Message[];
	generatedAt: string;
}

/**
 * 获取提供方的 API 密钥：先检查 OAuth 存储，再检查环境变量。
 */
async function getApiKey(provider: string): Promise<string | undefined> {
	const oauthKey = await resolveApiKey(provider);
	if (oauthKey) return oauthKey;
	return getEnvApiKey(provider);
}

/**
 * 同步检查 API 密钥是否可用（仅检查环境变量，供 skipIf 使用）。
 */
function hasApiKey(pair: ProviderModelPair): boolean {
	if (pair.provider === "azure") {
		return hasAzureOpenAICredentials();
	}
	if (pair.provider === "cloudflare-workers-ai") {
		return hasCloudflareWorkersAICredentials();
	}
	if (pair.provider === "cloudflare-ai-gateway") {
		if (!hasCloudflareAiGatewayCredentials()) return false;
		return pair.upstreamApiKeyEnv ? !!process.env[pair.upstreamApiKeyEnv] : true;
	}
	return !!getEnvApiKey(pair.provider);
}

function getHeaders(pair: ProviderModelPair): Record<string, string> | undefined {
	if (!pair.upstreamApiKeyEnv) return undefined;
	const upstreamApiKey = process.env[pair.upstreamApiKeyEnv];
	return upstreamApiKey ? { Authorization: `Bearer ${upstreamApiKey}` } : undefined;
}

/**
 * 检查是否有任一提供方具备可用 API 密钥（供 describe 层级的 skipIf 使用）。
 */
function hasAnyApiKey(): boolean {
	return PROVIDER_MODEL_PAIRS.some((pair) => hasApiKey(pair));
}

function dumpFailurePayload(params: { label: string; error: string; payload?: unknown; messages: Message[] }): void {
	const filename = `/tmp/pi-handoff-${params.label}-${Date.now()}.json`;
	const body = {
		label: params.label,
		error: params.error,
		payload: params.payload,
		messages: params.messages,
	};
	writeFileSync(filename, JSON.stringify(body, null, 2));
	console.log(`Wrote failure payload to ${filename}`);
}

/**
 * 根据提供方/模型组合生成上下文。
 * 通过真实 API 调用获取实际的工具调用 ID 和思考内容块。
 */
async function generateContext(
	pair: ProviderModelPair,
	apiKey: string,
): Promise<{ messages: Message[]; api: Api } | null> {
	const baseModel = (getModel as (p: string, m: string) => Model<Api> | undefined)(pair.provider, pair.model);
	if (!baseModel) {
		console.log(`  Model not found: ${pair.provider}/${pair.model}`);
		return null;
	}

	const model: Model<Api> = pair.apiOverride ? { ...baseModel, api: pair.apiOverride } : baseModel;

	const userMessage: Message = {
		role: "user",
		content: "Please double the number 21 using the double_number tool.",
		timestamp: Date.now(),
	};

	const supportsReasoning = model.reasoning === true;
	const headers = getHeaders(pair);
	let lastPayload: unknown;
	let assistantResponse: AssistantMessage;
	try {
		assistantResponse = await completeSimple(
			model,
			{
				systemPrompt: "You are a helpful assistant. Use the provided tool to complete the task.",
				messages: [userMessage],
				tools: [testTool],
			},
			{
				apiKey,
				reasoning: supportsReasoning ? "high" : undefined,
				headers,
				onPayload: (payload) => {
					lastPayload = payload;
				},
			},
		);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.log(`  Initial request failed: ${msg}`);
		dumpFailurePayload({
			label: `${pair.label}-initial`,
			error: msg,
			payload: lastPayload,
			messages: [userMessage],
		});
		return null;
	}

	if (assistantResponse.stopReason === "error") {
		console.log(`  Initial request error: ${assistantResponse.errorMessage}`);
		dumpFailurePayload({
			label: `${pair.label}-initial`,
			error: assistantResponse.errorMessage || "Unknown error",
			payload: lastPayload,
			messages: [userMessage],
		});
		return null;
	}

	const toolCall = assistantResponse.content.find((c) => c.type === "toolCall");
	if (!toolCall || toolCall.type !== "toolCall") {
		console.log(`  No tool call in response (stopReason: ${assistantResponse.stopReason})`);
		return {
			messages: [userMessage, assistantResponse],
			api: model.api,
		};
	}

	console.log(`  Tool call ID: ${toolCall.id}`);

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "42" }],
		isError: false,
		timestamp: Date.now(),
	};

	let finalResponse: AssistantMessage;
	const messagesForFinal = [userMessage, assistantResponse, toolResult];
	try {
		finalResponse = await completeSimple(
			model,
			{
				systemPrompt: "You are a helpful assistant.",
				messages: messagesForFinal,
				tools: [testTool],
			},
			{
				apiKey,
				reasoning: supportsReasoning ? "high" : undefined,
				headers,
				onPayload: (payload) => {
					lastPayload = payload;
				},
			},
		);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.log(`  Final request failed: ${msg}`);
		dumpFailurePayload({
			label: `${pair.label}-final`,
			error: msg,
			payload: lastPayload,
			messages: messagesForFinal,
		});
		return null;
	}

	if (finalResponse.stopReason === "error") {
		console.log(`  Final request error: ${finalResponse.errorMessage}`);
		dumpFailurePayload({
			label: `${pair.label}-final`,
			error: finalResponse.errorMessage || "Unknown error",
			payload: lastPayload,
			messages: messagesForFinal,
		});
		return null;
	}

	return {
		messages: [userMessage, assistantResponse, toolResult, finalResponse],
		api: model.api,
	};
}

describe.skipIf(!hasAnyApiKey())("Cross-Provider Handoff", () => {
	let contexts: Record<string, CachedContext>;
	let availablePairs: ProviderModelPair[];

	beforeAll(async () => {
		contexts = {};
		availablePairs = [];

		console.log("\n=== Generating Fixtures ===\n");

		for (const pair of PROVIDER_MODEL_PAIRS) {
			const apiKey = await getApiKey(pair.provider);
			if (!apiKey || !hasApiKey(pair)) {
				console.log(`[${pair.label}] Skipping - no auth for ${pair.provider}`);
				continue;
			}

			console.log(`[${pair.label}] Generating fixture...`);
			const result = await generateContext(pair, apiKey);

			if (!result || result.messages.length < 4) {
				console.log(`[${pair.label}] Failed to generate fixture, skipping`);
				continue;
			}

			contexts[pair.label] = {
				label: pair.label,
				provider: pair.provider,
				model: pair.model,
				api: result.api,
				messages: result.messages,
				generatedAt: new Date().toISOString(),
			};
			availablePairs.push(pair);
			console.log(`[${pair.label}] Generated ${result.messages.length} messages`);
		}

		console.log(`\n=== ${availablePairs.length}/${PROVIDER_MODEL_PAIRS.length} contexts available ===\n`);
	}, 300000);

	it.skipIf(!hasAnyApiKey())("should have at least 2 fixtures to test handoffs", () => {
		expect(Object.keys(contexts).length).toBeGreaterThanOrEqual(2);
	});

	it.skipIf(!hasAnyApiKey())(
		"should handle cross-provider handoffs for each target",
		async () => {
			const contextLabels = Object.keys(contexts);

			if (contextLabels.length < 2) {
				console.log("Not enough fixtures for handoff test, skipping");
				return;
			}

			console.log("\n=== Testing Cross-Provider Handoffs ===\n");

			const results: { target: string; success: boolean; error?: string }[] = [];

			for (const targetPair of availablePairs) {
				const apiKey = await getApiKey(targetPair.provider);
				if (!apiKey || !hasApiKey(targetPair)) {
					console.log(`[Target: ${targetPair.label}] Skipping - no auth`);
					continue;
				}

				// 收集其他所有上下文中的消息。
				const otherMessages: Message[] = [];
				for (const [label, ctx] of Object.entries(contexts)) {
					if (label === targetPair.label) continue;
					otherMessages.push(...ctx.messages);
				}

				if (otherMessages.length === 0) {
					console.log(`[Target: ${targetPair.label}] Skipping - no other contexts`);
					continue;
				}

				const allMessages: Message[] = [
					...otherMessages,
					{
						role: "user",
						content:
							"Great, thanks for all that help! Now just say 'Hello, handoff successful!' to confirm you received everything.",
						timestamp: Date.now(),
					},
				];

				const baseModel = (getModel as (p: string, m: string) => Model<Api> | undefined)(
					targetPair.provider,
					targetPair.model,
				);
				if (!baseModel) {
					console.log(`[Target: ${targetPair.label}] Model not found`);
					continue;
				}

				const model: Model<Api> = targetPair.apiOverride
					? { ...baseModel, api: targetPair.apiOverride }
					: baseModel;
				const supportsReasoning = model.reasoning === true;
				const headers = getHeaders(targetPair);

				console.log(
					`[Target: ${targetPair.label}] Testing with ${otherMessages.length} messages from other providers...`,
				);

				let lastPayload: unknown;
				try {
					const response = await completeSimple(
						model,
						{
							systemPrompt: "You are a helpful assistant.",
							messages: allMessages,
							tools: [testTool],
						},
						{
							apiKey,
							reasoning: supportsReasoning ? "high" : undefined,
							headers,
							onPayload: (payload) => {
								lastPayload = payload;
							},
						},
					);

					if (response.stopReason === "error") {
						console.log(`[Target: ${targetPair.label}] FAILED: ${response.errorMessage}`);
						dumpFailurePayload({
							label: targetPair.label,
							error: response.errorMessage || "Unknown error",
							payload: lastPayload,
							messages: allMessages,
						});
						results.push({ target: targetPair.label, success: false, error: response.errorMessage });
					} else {
						const text = response.content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join(" ");
						const preview = text.slice(0, 100).replace(/\n/g, " ");
						console.log(`[Target: ${targetPair.label}] SUCCESS: ${preview}...`);
						results.push({ target: targetPair.label, success: true });
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					console.log(`[Target: ${targetPair.label}] EXCEPTION: ${msg}`);
					dumpFailurePayload({
						label: targetPair.label,
						error: msg,
						payload: lastPayload,
						messages: allMessages,
					});
					results.push({ target: targetPair.label, success: false, error: msg });
				}
			}

			console.log("\n=== Results Summary ===\n");
			const successes = results.filter((r) => r.success);
			const failures = results.filter((r) => !r.success);

			console.log(`Passed: ${successes.length}/${results.length}`);
			if (failures.length > 0) {
				console.log("\nFailures:");
				for (const f of failures) {
					console.log(`  - ${f.target}: ${f.error}`);
				}
			}

			expect(failures.length).toBe(0);
		},
		600000,
	);
});
