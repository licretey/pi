/**
 * 测试各提供方对上下文溢出的错误处理。
 *
 * 当输入（提示词和历史记录）超过模型上下文窗口时，就会发生上下文溢出。
 * 这与输出令牌上限不同。
 *
 * 预期行为：所有提供方都应返回 stopReason: "error"，并通过 errorMessage 指明上下文过大；
 * 或者（对于 z.ai）成功返回，且 usage.input > contextWindow。
 *
 * 对所有提供方，isContextOverflow() 都必须返回 true。
 */

import type { ChildProcess } from "child_process";
import { execSync, spawn } from "child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complete, getModel, getModels } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { hasAzureOpenAICredentials } from "./azure-utils.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";
import { resolveApiKey } from "./oauth.ts";

// 在模块级别解析 OAuth 令牌（异步执行，先于测试运行）。
const oauthTokens = await Promise.all([resolveApiKey("github-copilot"), resolveApiKey("openai-codex")]);
const [githubCopilotToken, openaiCodexToken] = oauthTokens;

// 用于逼真估算令牌数的 Lorem ipsum 段落。
const LOREM_IPSUM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. `;

// 生成超出上下文窗口的字符串。
// 按每 4 个字符约等于一个令牌进行估算（多样文本比重复字符的估算更准确）。
function generateOverflowContent(contextWindow: number): string {
	const targetTokens = contextWindow + 10000; // 超出 1 万个 token。
	const targetChars = targetTokens * 4 * 1.5;
	const repetitions = Math.ceil(targetChars / LOREM_IPSUM.length);
	return LOREM_IPSUM.repeat(repetitions);
}

interface OverflowResult {
	provider: string;
	model: string;
	contextWindow: number;
	stopReason: string;
	errorMessage: string | undefined;
	usage: Usage;
	hasUsageData: boolean;
	response: AssistantMessage;
}

async function testContextOverflow(model: Model<any>, apiKey: string): Promise<OverflowResult> {
	const overflowContent = generateOverflowContent(model.contextWindow);

	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: overflowContent,
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(model, context, { apiKey });

	const hasUsageData = response.usage.input > 0 || response.usage.cacheRead > 0;

	return {
		provider: model.provider,
		model: model.id,
		contextWindow: model.contextWindow,
		stopReason: response.stopReason,
		errorMessage: response.errorMessage,
		usage: response.usage,
		hasUsageData,
		response,
	};
}

function logResult(result: OverflowResult) {
	console.log(`\n${result.provider} / ${result.model}:`);
	console.log(`  contextWindow: ${result.contextWindow}`);
	console.log(`  stopReason: ${result.stopReason}`);
	console.log(`  errorMessage: ${result.errorMessage}`);
	console.log(`  usage: ${JSON.stringify(result.usage)}`);
	console.log(`  hasUsageData: ${result.hasUsageData}`);
}

// =============================================================================
// Anthropic。
// 预期错误格式："prompt is too long: X tokens > Y maximum"。
// =============================================================================

describe("Context overflow error handling", () => {
	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic (API Key)", () => {
		it("claude-haiku-4-5 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("anthropic", "claude-haiku-4-5");
			const result = await testContextOverflow(model, process.env.ANTHROPIC_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/prompt is too long/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("Anthropic (OAuth)", () => {
		it("claude-sonnet-4 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("anthropic", "claude-sonnet-4-6");
			const result = await testContextOverflow(model, process.env.ANTHROPIC_OAUTH_TOKEN!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/prompt is too long/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// GitHub Copilot（OAuth）。
	// 通过 Copilot 同时测试 Google 和 Anthropic 模型。
	// =============================================================================

	describe("GitHub Copilot (OAuth)", () => {
		// 通过 Copilot 调用 Google 模型。
		it.skipIf(!githubCopilotToken)(
			"Google model - should detect overflow via isContextOverflow",
			async () => {
				const model = getModels("github-copilot").find((candidate) => candidate.id.startsWith("gemini-"));
				if (!model) throw new Error("No Google models available through GitHub Copilot");
				const result = await testContextOverflow(model, githubCopilotToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/exceeds the limit of \d+/i);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);

		// 通过 Copilot 调用 Anthropic 模型。
		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should detect overflow via isContextOverflow",
			async () => {
				const model = getModel("github-copilot", "claude-sonnet-4.6");
				const result = await testContextOverflow(model, githubCopilotToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/exceeds the limit of \d+|input is too long/i);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);
	});

	// =============================================================================
	// OpenAI 提供方。
	// 预期模式："exceeds the context window"。
	// =============================================================================

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions", () => {
		it("gpt-4o-mini - should detect overflow via isContextOverflow", async () => {
			const model = { ...getModel("openai", "gpt-4o-mini") };
			model.api = "openai-completions" as any;
			const result = await testContextOverflow(model, process.env.OPENAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses", () => {
		it("gpt-4o - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openai", "gpt-4o");
			const result = await testContextOverflow(model, process.env.OPENAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/exceeds the context window/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses", () => {
		it("gpt-4o-mini - should detect overflow via isContextOverflow", async () => {
			const model = getModel("azure", "gpt-4o-mini");
			const result = await testContextOverflow(model, process.env.AZURE_OPENAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/context|maximum/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Google 提供方。
	// 预期模式："input token count (X) exceeds the maximum"。
	// =============================================================================

	describe.skipIf(!process.env.GEMINI_API_KEY)("Google", () => {
		it("gemini-2.5-flash - should detect overflow via isContextOverflow", async () => {
			const model = getModel("google", "gemini-2.5-flash");
			const result = await testContextOverflow(model, process.env.GEMINI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/input token count.*exceeds the maximum/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// 使用与 Google 相同的 API，预期错误格式也相同。
	// =============================================================================

	// =============================================================================
	// =============================================================================

	// =============================================================================
	// OpenAI Codex（OAuth）。
	// 通过 OAuth 使用 ChatGPT Plus/Pro 订阅。
	// =============================================================================

	describe("OpenAI Codex (OAuth)", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should detect overflow via isContextOverflow",
			async () => {
				const model = getModel("openai-codex", "gpt-5.5");
				const result = await testContextOverflow(model, openaiCodexToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);
	});

	// =============================================================================
	// Amazon Bedrock。
	// 预期错误格式："Input is too long for requested model"。
	// =============================================================================

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock", () => {
		it("claude-sonnet-4-5 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
			const result = await testContextOverflow(model, "");
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// xAI 提供方。
	// 预期模式："maximum prompt length is X but the request contains Y"。
	// =============================================================================

	describe.skipIf(!process.env.XAI_API_KEY)("xAI", () => {
		it("grok-4.3 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("xai", "grok-4.3");
			const result = await testContextOverflow(model, process.env.XAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum prompt length is \d+/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Groq 提供方。
	// 预期模式："reduce the length of the messages"。
	// =============================================================================

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq", () => {
		it("llama-3.3-70b-versatile - should detect overflow via isContextOverflow", async () => {
			const model = getModel("groq", "llama-3.3-70b-versatile");
			const result = await testContextOverflow(model, process.env.GROQ_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/reduce the length of the messages/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Cerebras 提供方。
	// 预期结果：状态码为 400 或 413，且响应体为空。
	// =============================================================================

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras", () => {
		it("available model - should detect overflow via isContextOverflow", async () => {
			const preferredCerebrasModelIds: string[] = ["gpt-oss-120b", "zai-glm-4.7", "llama3.1-8b"];
			const cerebrasModels = getModels("cerebras");
			const model =
				cerebrasModels.find((candidate) => preferredCerebrasModelIds.includes(candidate.id)) ?? cerebrasModels[0];
			if (!model) {
				throw new Error("No Cerebras models available");
			}

			const result = await testContextOverflow(model, process.env.CEREBRAS_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			// Cerebras 在响应体为空时返回状态码（400、413；token 限流时为 429）。
			expect(result.errorMessage).toMatch(/4(00|13|29).*\(no body\)/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Hugging Face。
	// 使用兼容 OpenAI 的 Inference Router。
	// =============================================================================

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face", () => {
		it("Kimi-K2.5 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("huggingface", "moonshotai/Kimi-K2.5");
			const result = await testContextOverflow(model, process.env.HF_TOKEN!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Together AI。
	// 使用兼容 OpenAI 的 Chat Completions API。
	// =============================================================================

	describe.skipIf(!process.env.TOGETHER_API_KEY)("Together AI", () => {
		it("Kimi-K3 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("together", "moonshotai/Kimi-K3");
			const result = await testContextOverflow(model, process.env.TOGETHER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// z.ai
	// 特殊情况：可能返回明确的溢出错误文本，也可能静默接受超限输入，
	// 或改为触发速率限制。
	// =============================================================================

	describe.skipIf(!process.env.ZAI_API_KEY)("z.ai", () => {
		it("glm-5.2 - should detect overflow via isContextOverflow when z.ai reports it", async () => {
			const model = getModel("zai", "glm-5.2");
			const result = await testContextOverflow(model, process.env.ZAI_API_KEY!);
			logResult(result);

			// z.ai 的行为不一致：
			// - 有时通过非标准的 finish_reason 处理返回明确的溢出错误文本。
			// - 有时接受超限输入并成功返回，且 usage.input > contextWindow。
			// - 有时会返回限流错误。
			if (result.stopReason === "error") {
				if (result.errorMessage?.match(/model_context_window_exceeded/i)) {
					expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
				} else {
					console.log("  z.ai returned non-overflow error (possibly rate limited), skipping overflow detection");
				}
			} else if (result.stopReason === "stop") {
				if (result.hasUsageData && result.usage.input > model.contextWindow) {
					expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
				} else {
					console.log("  z.ai returned stop without overflow usage data, skipping overflow detection");
				}
			}
		}, 120000);
	});

	// =============================================================================
	// Mistral 提供方。
	// =============================================================================

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral", () => {
		it("devstral-medium-latest - should detect overflow via isContextOverflow", async () => {
			const model = getModel("mistral", "devstral-medium-latest");
			const result = await testContextOverflow(model, process.env.MISTRAL_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/too large for model with \d+ maximum context length/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// MiniMax 提供方。
	// 预期错误格式：待定，需通过实际测试确认错误消息。
	// =============================================================================

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax", () => {
		it("MiniMax-M2.7 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("minimax", "MiniMax-M2.7");
			const result = await testContextOverflow(model, process.env.MINIMAX_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Xiaomi MiMo。
	// =============================================================================

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing)", () => {
		// Xiaomi 会静默截断超大输入，使其恰好填满上下文窗口，
		// 随后返回 finish_reason "length" 且 output=0（没有剩余空间用于生成）。
		// 这是可检测的溢出信号，但 stopReason 为 "length" 而不是 "error"。
		it("mimo-v2.5-pro - should detect overflow via isContextOverflow", async () => {
			const model = getModel("xiaomi", "mimo-v2.5-pro");
			const result = await testContextOverflow(model, process.env.XIAOMI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("length");
			expect(result.usage.output).toBe(0);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)("Xiaomi MiMo Token Plan (CN)", () => {
		it("mimo-v2.5-pro - should detect overflow via isContextOverflow", async () => {
			const model = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");
			const result = await testContextOverflow(model, process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("length");
			expect(result.usage.output).toBe(0);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)("Xiaomi MiMo Token Plan (AMS)", () => {
		it("mimo-v2.5-pro - should detect overflow via isContextOverflow", async () => {
			const model = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");
			const result = await testContextOverflow(model, process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("length");
			expect(result.usage.output).toBe(0);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)("Xiaomi MiMo Token Plan (SGP)", () => {
		it("mimo-v2.5-pro - should detect overflow via isContextOverflow", async () => {
			const model = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");
			const result = await testContextOverflow(model, process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("length");
			expect(result.usage.output).toBe(0);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)("Qwen Token Plan", () => {
		it("qwen3.7-max - should detect overflow via isContextOverflow", async () => {
			const model = getModel("qwen-token-plan", "qwen3.7-max");
			const result = await testContextOverflow(model, process.env.QWEN_TOKEN_PLAN_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/input length/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)("Qwen Token Plan Individual", () => {
		it("qwen3.8-max - should detect overflow via isContextOverflow", async () => {
			const model = getModel("qwen-token-plan-individual", "qwen3.8-max");
			const result = await testContextOverflow(model, process.env.QWEN_TOKEN_PLAN_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/input length/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_CN_API_KEY)("Qwen Token Plan (CN)", () => {
		it("qwen3.7-max - should detect overflow via isContextOverflow", async () => {
			const model = getModel("qwen-token-plan-cn", "qwen3.7-max");
			const result = await testContextOverflow(model, process.env.QWEN_TOKEN_PLAN_CN_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/input length/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Kimi For Coding。
	// =============================================================================

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding", () => {
		it("kimi-for-coding - should detect overflow via isContextOverflow", async () => {
			const model = getModel("kimi-coding", "kimi-for-coding");
			const result = await testContextOverflow(model, process.env.KIMI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Vercel AI Gateway：多个提供方的统一 API。
	// =============================================================================

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway", () => {
		it("google/gemini-2.5-flash via AI Gateway - should detect overflow via isContextOverflow", async () => {
			const model = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");
			const result = await testContextOverflow(model, process.env.AI_GATEWAY_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// OpenRouter：多个后端提供方。
	// 预期错误格式："maximum context length is X tokens"。
	// =============================================================================

	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter", () => {
		// Anthropic 后端。
		it("anthropic/claude-sonnet-4 via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "anthropic/claude-sonnet-4");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// DeepSeek 后端。
		it("deepseek/deepseek-v3.2 via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "deepseek/deepseek-v3.2");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// Mistral 后端。
		it("mistralai/mistral-large-2512 via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "mistralai/mistral-large");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// Google 后端。
		it("google/gemini-2.5-flash via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "google/gemini-2.5-flash");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// Meta/Llama 后端
		it("meta-llama/llama-4-scout via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "meta-llama/llama-4-scout");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Ollama（本地）。
	// =============================================================================

	// 检查是否安装了 ollama，以及是否启用了本地 LLM 测试。
	let ollamaInstalled = false;
	if (!process.env.PI_NO_LOCAL_LLM) {
		try {
			execSync("which ollama", { stdio: "ignore" });
			ollamaInstalled = true;
		} catch {
			ollamaInstalled = false;
		}
	}

	describe.skipIf(!ollamaInstalled)("Ollama (local)", () => {
		let ollamaProcess: ChildProcess | null = null;
		let model: Model<"openai-completions">;

		beforeAll(async () => {
			// 检查模型是否可用；如果不可用，则拉取模型。
			try {
				execSync("ollama list | grep -q 'gpt-oss:20b'", { stdio: "ignore" });
			} catch {
				console.log("Pulling gpt-oss:20b model for Ollama overflow tests...");
				try {
					execSync("ollama pull gpt-oss:20b", { stdio: "inherit" });
				} catch (_e) {
					console.warn("Failed to pull gpt-oss:20b model, tests will be skipped");
					return;
				}
			}

			// 启动 ollama 服务器。
			ollamaProcess = spawn("ollama", ["serve"], {
				detached: false,
				stdio: "ignore",
			});

			// 等待服务器就绪。
			await new Promise<void>((resolve) => {
				const checkServer = async () => {
					try {
						const response = await fetch("http://localhost:11434/api/tags");
						if (response.ok) {
							resolve();
						} else {
							setTimeout(checkServer, 500);
						}
					} catch {
						setTimeout(checkServer, 500);
					}
				};
				setTimeout(checkServer, 1000);
			});

			model = {
				id: "gpt-oss:20b",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				name: "Ollama GPT-OSS 20B",
			};
		}, 60000);

		afterAll(() => {
			if (ollamaProcess) {
				ollamaProcess.kill("SIGTERM");
				ollamaProcess = null;
			}
		});

		it("gpt-oss:20b - should detect overflow via isContextOverflow (ollama silently truncates)", async () => {
			const result = await testContextOverflow(model, "ollama");
			logResult(result);

			// Ollama 会静默截断输入，而不是返回错误。
			// 它会返回 stopReason "stop"，并附带截断后的用量数据。
			// 无法通过错误消息检测溢出，只能比较用量数据。
			if (result.stopReason === "stop" && result.hasUsageData) {
				// Ollama 已截断输入；检查报告的用量是否小于发送的输入量。
				// 这是“静默溢出”：如果知道预期输入大小，就可以检测出来。
				console.log("  Ollama silently truncated input to", result.usage.input, "tokens");
				// 目前接受这种行为；Ollama 没有提供检测溢出的方式。
			} else if (result.stopReason === "error") {
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			}
		}, 300000); // 本地模型的超时时间为 5 分钟。
	});

	// =============================================================================
	// LM Studio（本地）：未运行或未启用本地 LLM 测试时跳过。
	// =============================================================================

	let lmStudioRunning = false;
	if (!process.env.PI_NO_LOCAL_LLM) {
		try {
			execSync("curl -s --max-time 1 http://localhost:1234/v1/models > /dev/null", { stdio: "ignore" });
			lmStudioRunning = true;
		} catch {
			lmStudioRunning = false;
		}
	}

	describe.skipIf(!lmStudioRunning)("LM Studio (local)", () => {
		it("should detect overflow via isContextOverflow", async () => {
			const model: Model<"openai-completions"> = {
				id: "local-model",
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl: "http://localhost:1234/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 8192,
				maxTokens: 2048,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				name: "LM Studio Local Model",
			};

			const result = await testContextOverflow(model, "lm-studio");
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// 本地 llama.cpp 服务器：未运行或未提供 /v1/completions 时跳过。
	// =============================================================================

	let llamaCppRunning = false;
	if (!process.env.PI_NO_LOCAL_LLM) {
		try {
			execSync("curl -s --max-time 1 http://localhost:8081/health > /dev/null", { stdio: "ignore" });
			const probeStatus = execSync(
				'curl -s --max-time 1 -o /dev/null -w \'%{http_code}\' -X POST http://localhost:8081/v1/completions -H \'content-type: application/json\' -d \'{"model":"local-model","prompt":"ping","max_tokens":1}\'',
				{ encoding: "utf8" },
			).trim();
			llamaCppRunning = probeStatus !== "404" && probeStatus !== "405" && probeStatus !== "000";
		} catch {
			llamaCppRunning = false;
		}
	}

	describe.skipIf(!llamaCppRunning)("llama.cpp (local)", () => {
		it("should detect overflow via isContextOverflow", async () => {
			// 使用较小的上下文长度（4096），与服务器的 --ctx-size 设置一致。
			const model: Model<"openai-completions"> = {
				id: "local-model",
				api: "openai-completions",
				provider: "llama.cpp",
				baseUrl: "http://localhost:8081/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 4096,
				maxTokens: 2048,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				name: "llama.cpp Local Model",
			};

			const result = await testContextOverflow(model, "llama.cpp");
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});
});
