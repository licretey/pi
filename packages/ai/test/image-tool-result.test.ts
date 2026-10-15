import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Api, Context, Model, Tool, ToolResultMessage } from "../src/compat.ts";
import { complete, getModel } from "../src/compat.ts";
import type { StreamOptions } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";
import { resolveApiKey } from "./oauth.ts";

// 在模块级解析 OAuth 令牌（异步执行，在测试开始前完成）
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

/**
 * 测试仅包含图片的工具结果能否在所有提供方中正常工作。
 * 此测试用于验证：
 * 1. 工具结果可以包含图片内容块
 * 2. 提供方能将工具结果中的图片正确传递给大语言模型
 * 3. 大语言模型能够识别并描述工具返回的图片
 */
async function handleToolWithImageResult<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// 检查模型是否支持图片
	if (!model.input.includes("image")) {
		console.log(`Skipping tool image result test - model ${model.id} doesn't support images`);
		return;
	}

	// 读取测试图片
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// 定义一个仅返回图片（不含文本）的工具
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle",
		description: "Returns a circle image for visualization",
		parameters: getImageSchema,
	};

	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content: "Call the get_circle tool to get an image, and describe what you see, shapes, colors, etc.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// 第一次请求：大语言模型应调用该工具
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// 查找工具调用
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle");

	// 将工具调用添加到上下文
	context.messages.push(firstResponse);

	// 创建仅包含图片（不含文本）的工具结果
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// 第二次请求：要求大语言模型描述工具结果中的图片
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// 验证大语言模型能够识别并描述图片
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// 图片显示红色圆形，因此回答应提及红色和圆形
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

/**
 * 测试同时包含文本和图片的工具结果能否在所有提供方中正常工作。
 * 此测试用于验证：
 * 1. 工具结果可以包含混合内容块（文本和图片）
 * 2. 提供方能将工具结果中的文本和图片都正确传递给大语言模型
 * 3. 大语言模型能够读取工具结果中的文本并识别图片
 */
async function handleToolWithTextAndImageResult<TApi extends Api>(
	model: Model<TApi>,
	options?: StreamOptionsWithExtras,
) {
	// 检查模型是否支持图片
	if (!model.input.includes("image")) {
		console.log(`Skipping tool text+image result test - model ${model.id} doesn't support images`);
		return;
	}

	// 读取测试图片
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// 定义一个同时返回文本和图片的工具
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle_with_description",
		description: "Returns a circle image with a text description",
		parameters: getImageSchema,
	};

	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content:
					"Use the get_circle_with_description tool and tell me what you learned. Also say what color the shape is.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// 第一次请求：大语言模型应调用该工具
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// 查找工具调用
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle_with_description");

	// 将工具调用添加到上下文
	context.messages.push(firstResponse);

	// 创建同时包含文本和图片的工具结果
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "text",
				text: "This is a geometric shape with specific properties: it has a diameter of 100 pixels.",
			},
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// 第二次请求：要求大语言模型描述工具结果中的文本和图片
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// 验证大语言模型能够读取文本并识别图片
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// 回答应提及文本中的信息（直径和像素数）
		expect(lowerContent.match(/diameter|100|pixel/)).toBeTruthy();
		// 回答还应提及视觉特征（红色和圆形）
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

describe("Tool Results with Images", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider (gemini-2.5-flash)", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider (gpt-4o-mini)", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider (gpt-5-mini)", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider (gpt-4o-mini)", () => {
		const llm = getModel("azure", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm, azureOptions);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider (claude-haiku-4-5)", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(model);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(model);
		});
	});

	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter Provider (glm-4.5v)", () => {
		const llm = getModel("openrouter", "z-ai/glm-4.5v");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider (pixtral-12b)", () => {
		const llm = getModel("mistral", "pixtral-12b");

		it("should handle tool result with only image", { retry: 5, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 5, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.TOGETHER_API_KEY)("Together AI Provider (Kimi-K3)", () => {
		const llm = getModel("together", "moonshotai/Kimi-K3");
		const options = { reasoningEffort: "high" } satisfies StreamOptionsWithExtras;

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm, options);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm, options);
		});
	});

	describe.skipIf(!process.env.BASETEN_API_KEY)("Baseten Provider (Kimi-K2.6)", () => {
		const llm = getModel("baseten", "moonshotai/Kimi-K2.6");
		const options = { reasoningEffort: "high" } satisfies StreamOptionsWithExtras;

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm, options);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm, options);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider (mimo-v2.5-pro)", () => {
		const llm = getModel("xiaomi", "mimo-v2.5-pro");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// FIXME(xiaomi)：当 tool_result 同时包含描述性文本块和图片块时，MiMo 会只关注文本而忽略图片
		// （它会报告从文本得出的直径，却不提及图片颜色）。上面的纯图片用例证明图片已传到模型，
		// 纯文本路径也能正常工作，因此这是模型的多模态融合质量问题，而非传输故障。
		// 等上游模型质量改善后再启用。
		it.skip("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)(
		"Xiaomi MiMo Token Plan (CN) Provider (mimo-v2.5-pro)",
		() => {
			const llm = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

			it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithImageResult(llm);
			});

			// FIXME(xiaomi)：参见上面的 API 计费测试块；Token Plan 端点也有相同的多模态融合限制
			// （两个端点使用的是同一模型）。
			it.skip("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithTextAndImageResult(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)(
		"Xiaomi MiMo Token Plan (AMS) Provider (mimo-v2.5-pro)",
		() => {
			const llm = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

			it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithImageResult(llm);
			});

			// FIXME(xiaomi)：参见上面的 API 计费测试块；Token Plan 端点也有相同的多模态融合限制
			// （两个端点使用的是同一模型）。
			it.skip("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithTextAndImageResult(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)(
		"Xiaomi MiMo Token Plan (SGP) Provider (mimo-v2.5-pro)",
		() => {
			const llm = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

			it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithImageResult(llm);
			});

			// FIXME(xiaomi)：参见上面的 API 计费测试块；Token Plan 端点也有相同的多模态融合限制
			// （两个端点使用的是同一模型）。
			it.skip("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithTextAndImageResult(llm);
			});
		},
	);

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)("Qwen Token Plan Provider (qwen3.7-max)", () => {
		const llm = getModel("qwen-token-plan", "qwen3.7-max");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)("Qwen Token Plan Individual Provider (qwen3.8-max)", () => {
		const llm = getModel("qwen-token-plan-individual", "qwen3.8-max");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_CN_API_KEY)("Qwen Token Plan (CN) Provider (qwen3.7-max)", () => {
		const llm = getModel("qwen-token-plan-cn", "qwen3.7-max");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider (kimi-for-coding)", () => {
		const llm = getModel("kimi-coding", "kimi-for-coding");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider (google/gemini-2.5-flash)", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-sonnet-4-5)", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	// =========================================================================
	// 基于 OAuth 的提供方（凭据来自 ~/.pi/agent/oauth.json）
	// =========================================================================

	describe("Anthropic OAuth Provider (claude-sonnet-4-5)", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");

		it.skipIf(!anthropicOAuthToken)(
			"should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				await handleToolWithImageResult(model, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				await handleToolWithTextAndImageResult(model, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"claude-haiku-4.5 - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-haiku-4.5");
				await handleToolWithImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-haiku-4.5 - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-haiku-4.5");
				await handleToolWithTextAndImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await handleToolWithImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await handleToolWithTextAndImageResult(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await handleToolWithImageResult(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await handleToolWithTextAndImageResult(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});
