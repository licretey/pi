import type { AssistantMessage } from "../types.ts";

/**
 * 用于检测不同提供商上下文溢出错误的正则模式。
 *
 * 这些模式匹配输入超出模型上下文窗口时返回的错误消息。
 *
 * 各提供商专属模式（附示例错误消息）：
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - OpenAI/LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - OpenAI 兼容: "Input length (265330) exceeds model's maximum context length (262144)."
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - Cerebras: "400/413 status code (no body)"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: `{"code":"1261","message":"Prompt too long"}`、`{"code":"1261","message":"Prompt exceeds max length"}`（CN 端点），或通过 usage.input > contextWindow 表现为静默溢出
 * - Xiaomi MiMo: 将输入截断到恰好填满 contextWindow，然后返回 finish_reason "length" 且
 *   output=0（已无剩余空间可生成）。通过 stopReason "length" + 零输出 +
 *   输入填满上下文窗口来检测。
 * - DashScope/Qwen: "Range of input length should be [1, X]"（HTTP 400 invalid_parameter_error）
 * - Ollama: 部分部署会静默截断，另一些会返回诸如 "prompt too long; exceeded max context length by X tokens" 的错误
 */
const OVERFLOW_PATTERNS = [
	/prompt (?:is )?too long/i, // Anthropic 和 z.ai 的 token 溢出
	/prompt exceeds max length/i, // z.ai CN 端点的 token 溢出
	/request_too_large/i, // Anthropic 的请求字节数溢出（HTTP 413）
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI（Completions 与 Responses API）
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI 兼容代理（LiteLLM）
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter（大多数后端）
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
	/model_context_window_exceeded/i, // z.ai 以错误文本暴露的非标准 finish_reason
	/prompt too long; exceeded (?:max )?context length/i, // Ollama 显式溢出错误
	/range of input length should be/i, // DashScope / Qwen Token Plan
	/context[_ ]length[_ ]exceeded/i, // 通用兜底
	/too many tokens/i, // 通用兜底
	/token limit exceeded/i, // 通用兜底
];

const CEREBRAS_BODYLESS_OVERFLOW_PATTERN = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i;

/**
 * 表示非溢出错误的模式（例如限流、服务器错误）。
 * 匹配其中任意一条的错误消息会被排除出溢出检测，
 * 即便它同时也匹配某条 OVERFLOW_PATTERN。
 *
 * 示例：Bedrock 将限流错误格式化为 "ThrottlingException: Too many tokens,
 * please wait before trying again."，若没有这条排除规则，它会匹配
 * /too many tokens/i 溢出模式。
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock 非溢出错误（来自 formatBedrockError 的人类可读前缀）
	/rate limit/i, // 通用限流
	/too many requests/i, // 通用 HTTP 429 风格
];

/**
 * 判断一条 assistant 消息是否代表上下文溢出错误。
 *
 * 处理三种情况：
 * 1. 基于错误的溢出：大多数提供商返回 stopReason "error" 并带有
 *    特定的错误消息模式。
 * 2. 静默溢出：有些提供商接受溢出请求并成功返回。对这类情况，
 *    我们检查 usage.input 是否超出上下文窗口。
 * 3. 长度停止溢出：Xiaomi MiMo 在输入填满上下文窗口时可能返回
 *    "length" 且零输出。
 *
 * ## 各提供商检测可靠性
 *
 * **可靠检测（返回带可识别消息的错误）：**
 * - Anthropic: "prompt is too long: X tokens > Y maximum" 或 "request_too_large"
 * - OpenAI (Completions & Responses): "exceeds the context window"、“exceeds the model's maximum context length of X tokens” 或 "exceeds model's maximum context length (X)"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI (Grok): "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras: 400/413 status code (no body)
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenRouter（大多数后端）: "maximum context length is X tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - DashScope/Qwen: "Range of input length should be [1, X]"
 * - z.ai: "Prompt too long"
 *
 * **不可靠检测：**
 * - z.ai: 有时静默接受溢出（可通过 usage.input > contextWindow 检测），
 *   有时返回限流错误。传入 contextWindow 参数以检测静默溢出。
 * - Xiaomi MiMo: 将输入截断以适配 contextWindow，然后返回 stopReason "length" 且
 *   output=0。传入 contextWindow 参数，通过“上下文填满 + 零输出”信号检测。
 * - Ollama: 某些配置下可能静默截断输入，但也可能返回符合上述模式的显式
 *   溢出错误。静默截断在此仍无法检测，因为我们不知道预期 token 数。
 *
 * ## 自定义提供商
 *
 * 如果你通过 settings.json 添加了自定义模型，此函数可能无法检测这些提供商的
 * 溢出错误。要增加支持：
 *
 * 1. 发送一个超出模型上下文窗口的请求
 * 2. 查看响应中的 errorMessage
 * 3. 编写一个能匹配该错误的正则模式
 * 4. 将该模式加入本文件的 OVERFLOW_PATTERNS，或者
 *    在调用本函数前自行检查 errorMessage
 *
 * @param message - 要检查的 assistant 消息
 * @param contextWindow - 可选的上下文窗口大小，用于检测静默溢出（z.ai）
 * @returns 如果消息表示上下文溢出则为 true
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// 情况 1：检查错误消息模式
	if (message.stopReason === "error" && message.errorMessage) {
		// 跳过匹配已知非溢出模式的消息（例如限流 / 频率限制）
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow) {
			if (OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
				return true;
			}
			if (message.provider === "cerebras" && CEREBRAS_BODYLESS_OVERFLOW_PATTERN.test(message.errorMessage)) {
				return true;
			}
		}
	}

	// 情况 2：静默溢出（z.ai 风格）—— 请求成功但用量超出上下文
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// 情况 3：长度停止溢出（Xiaomi MiMo 风格）—— 服务器将超长输入截断以
	// 适配上下文窗口，不再留任何输出空间。返回 stopReason "length"、
	// output=0，且 input+cacheRead 恰好填满上下文窗口。
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/**
 * 判断 length 停止是否低于调用方或模型预期的输出上限。
 * 这类响应可能由上下文压力或提供商侧截断导致，因此调用方可以
 * 做一次有界的「压缩后重试」尝试。`desiredMaxOutput` 必须是任何
 * 基于上下文的钳制之前的原始上限。
 */
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
	return message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput;
}

/**
 * 获取溢出模式，用于测试。
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
