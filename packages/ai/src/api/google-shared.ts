/**
 * Google Generative AI 与 Google Vertex provider 共用的工具函数。
 */

import {
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	ThinkingLevel as GoogleSdkThinkingLevel,
	type Part,
	type ThinkingConfig,
} from "@google/genai";
import { clampThinkingLevel } from "../models.ts";
import type {
	ImageContent,
	Model,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingLevel,
	Tool,
	TranscriptContext,
} from "../types.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { collapseSystemMessages, withoutInitialSystemMessage } from "../utils/transcript.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Gemini 3 模型使用的 thinking level。
 * 与 Google 的 ThinkingLevel 枚举值一一对应。
 */
export type GoogleApiThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

const GOOGLE_SDK_THINKING_LEVEL_MAP: Record<GoogleApiThinkingLevel, GoogleSdkThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: GoogleSdkThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: GoogleSdkThinkingLevel.MINIMAL,
	LOW: GoogleSdkThinkingLevel.LOW,
	MEDIUM: GoogleSdkThinkingLevel.MEDIUM,
	HIGH: GoogleSdkThinkingLevel.HIGH,
};

/** 把受支持的 pi level 或模型专属的 Google 映射解析为标准 Google level。 */
export function resolveGoogleThinkingLevel<T extends GoogleApiType>(
	model: Model<T>,
	level: ThinkingLevel,
): ResolvedGoogleThinkingLevel {
	const mapped = model.thinkingLevelMap?.[level];
	const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
	switch (resolvedLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return resolvedLevel;
		default:
			throw new Error(
				`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`,
			);
	}
}

/**
 * 该模型是否使用 Gemini 离散的 `thinkingLevel` 控制，而不是基于 token 的
 * `thinkingBudget` 控制。受支持的 level 来自模型的 `thinkingLevelMap`；
 * 这里只是选择 Google 的线上传输格式。
 */
export function usesGoogleThinkingLevel<T extends GoogleApiType>(model: Model<T>): boolean {
	const id = model.id.toLowerCase();
	return (
		// 匹配带或不带次版本号的 Gemini 3 Pro/Flash ID，例如
		// gemini-3-flash-preview、gemini-3.1-pro-preview 与 gemini-3.8-flash。
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest" ||
		// 匹配两种线上 Gemma 4 命名形式：gemma-4-* 与 gemma4-*。
		/gemma-?4/.test(id)
	);
}

export function toGoogleThinkingLevel(level: ResolvedGoogleThinkingLevel): GoogleApiThinkingLevel {
	switch (level) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

export function toGoogleSdkThinkingLevel(level: GoogleApiThinkingLevel): GoogleSdkThinkingLevel {
	return GOOGLE_SDK_THINKING_LEVEL_MAP[level];
}

export function getDisabledGoogleThinkingConfig<T extends GoogleApiType>(model: Model<T>): ThinkingConfig {
	if (!usesGoogleThinkingLevel(model)) return { thinkingBudget: 0 };

	const fallback = clampThinkingLevel(model, "off");
	if (fallback === "off") return { thinkingBudget: 0 };

	const resolvedLevel = resolveGoogleThinkingLevel(model, fallback);
	const apiLevel = toGoogleThinkingLevel(resolvedLevel);
	return { thinkingLevel: toGoogleSdkThinkingLevel(apiLevel) };
}

/**
 * 判断流式返回的 Gemini `Part` 是否应视为"thinking"。
 *
 * 协议说明（Gemini / Vertex AI thought signature）：
 * - `thought: true` 是思考内容（thought 摘要）的权威标记。
 * - `thoughtSignature` 是模型内部思考过程的加密表示，用于在多轮交互间
 *   保存推理上下文。
 * - `thoughtSignature` 可以出现在任何 part 类型上（text、functionCall 等）——它并不
 *   表示该 part 本身就是思考内容。
 * - 对非 functionCall 的响应，签名出现在最后一个 part 上，用于上下文回放。
 * - 持久化/回放模型输出时，带签名的 part 必须原样保留；
 *   不要跨 part 合并或移动签名。
 *
 * 参见：https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * 流式过程中保留 thought signatures。
 *
 * 有的后端只会在给定 part/block 的第一个 delta 上发送 `thoughtSignature`；后续 delta 可能省略它。
 * 该辅助函数为当前 block 保留最近一个非空签名。
 *
 * 注意：它不会跨不同响应 part 合并或移动签名。它只是防止同一流式 block 内
 * 签名被 `undefined` 覆盖。
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signature 对 Google API（TYPE_BYTES）必须是 base64。
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * 只保留来自同一 provider/model 且 base64 合法的签名。
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * 通过 Google API 访问、需要在 function 调用/响应中使用显式 tool call ID 的模型。
 */
export function requiresToolCallId(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
	);
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * 将内部消息转换为 Gemini Content[] 格式。
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: TranscriptContext): Content[] {
	// Gemini 没有会话中途的系统消息；开头的 prompt 作为 systemInstruction 发送。
	const conversation = withoutInitialSystemMessage(collapseSystemMessages(context).messages);
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(conversation, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// 检查消息是否来自同一 provider 和 model——只有此时才保留 thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					// 跳过空文本块——除非它携带 thought signature。Gemini 可能把签名附着在一个可见文本为空的
					// part 上，并要求该签名被原样回传；丢掉它会破坏推理链，模型会间歇性地以 thought-only 的
					// STOP（空完成、无 tool call）提前结束回合。
					if ((!block.text || block.text.trim() === "") && !thoughtSignature) continue;
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// 只有同一 provider 且同一 model 时才保留为 thinking block
					// 否则转成纯文本（不用标签，避免模型模仿）
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						// 与文本块相同的规则：空 thinking block 只在
						// 不携带签名时才被丢弃（对应 anthropic 转换器的处理）。
						if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) continue;
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						// 跨 provider/model 时：签名不可用，空块保持被丢弃。
						if (!block.thinking || block.thinking.trim() === "") continue;
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// 提取文本与图片内容
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ 模型支持多模态 function 响应，图片嵌在 functionResponse.parts 内。Cloud Code Assist
			// 之后的 Claude 等非 Gemini 模型，或 Gemini < 3，仍需要一个单独的 user 图片轮。
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// 按 SDK 文档，成功用 "output" 键，错误用 "error" 键
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API 要求所有 function 响应位于同一个 user 轮。
			// 检查最后的内容是否已是带 function 响应的 user 轮，是则合并。
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// 对 Gemini < 3，把图片放进单独的 user 消息
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // $defs 的 pre-draft-2019-09 等价物
]);

/**
 * 从 schema 对象中剥离元声明（meta-declaration）
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/**
 * 把工具转换为 Gemini function declarations 格式。
 *
 * 默认使用 `parametersJsonSchema`，它支持完整 JSON Schema（包括
 * anyOf、oneOf、const 等）。把 `useParameters` 设为 true 则改用旧版 `parameters`
 * 字段（OpenAPI 3.03 Schema）。Cloud Code Assist 下的 Claude 模型需要这种方式，
 * 因为 API 会把 `parameters` 翻译成 Anthropic 的 `input_schema`。
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
	supportsStrictMode = true,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => {
				const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
				const parameters = getJsonSchemaToolParameters(tool, strict);
				return {
					name: tool.name,
					description: tool.description,
					...(useParameters
						? { parameters: sanitizeForOpenApi(parameters as unknown) }
						: { parametersJsonSchema: parameters }),
				};
			}),
		},
	];
}

/** Gemini 3+ 在经过校验的工具调用模式下强制要求 function 参数必填。 */
export function supportsGoogleStrictToolSampling(modelId: string): boolean {
	const majorVersion = getGeminiMajorVersion(modelId);
	return majorVersion !== undefined && majorVersion >= 3;
}

/** 把 tool choice 字符串映射为 Gemini 的 FunctionCallingConfigMode。 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

export function resolveGoogleFunctionCallingMode(
	tools: Tool[],
	toolChoice: string | undefined,
	supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
	const useStrictMode = tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true);
	if (toolChoice === "none" || toolChoice === "any") {
		return mapToolChoice(toolChoice);
	}
	if (useStrictMode) {
		return FunctionCallingConfigMode.VALIDATED;
	}
	return toolChoice ? mapToolChoice(toolChoice) : undefined;
}

/**
 * 将 Gemini 的 FinishReason 映射为我们的 StopReason。
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.TOO_MANY_TOOL_CALLS:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * 把字符串形式的 finish reason 映射为我们的 StopReason（针对原始 API 响应）。
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

/**
 * 以共享的 provider 重试策略（408/409/429/5xx，带退避并遵守 retry-after）执行一次
 * Google GenAI SDK 请求，与 Anthropic、OpenAI 适配器把初始请求包进
 * retryProviderRequest 的做法一致。SDK 的 ApiError 有 `status` 属性但没有
 * `headers` 属性，而 retryProviderRequest 只重试两者兼备的错误，因此在
 * 重新抛出之前，补上缺失的 `headers` 以归一化错误。
 */
export function retryGoogleRequest<T>(
	request: () => Promise<T>,
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
	return retryProviderRequest(
		async () => {
			try {
				return await request();
			} catch (error) {
				if (error instanceof Error && "status" in error && !("headers" in error)) {
					(error as { headers?: Headers }).headers = undefined;
				}
				throw error;
			}
		},
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
}
