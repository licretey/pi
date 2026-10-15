import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode 的 Zen API 以 429 JSON 错误类型返回的 Go/免费额度限制。
	// 这些是订阅/账户额度，不是瞬时限流。
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go 的订阅额度文本要求用户在达到滚动/周/月额度后
	// 启用可用余额使用方式。
	"Monthly usage limit reached",
	"available balance",

	// 通用的配额/预算/计费耗尽。`insufficient_quota` 是 OpenAI 的
	// 配额/计费错误码；其余字符串覆盖常见网关措辞。
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",

	// 使用 ChatGPT 登录：订阅共享用量限制，按小时而非按秒重置。
	"subscription_sharing_usage_limit_exceeded",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// 通用的提供商负载、HTTP 状态码与服务器侧瞬态故障。
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"520",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// 上游瞬态失败的包装层/提供商文本，包括 OpenRouter
	// "Provider returned error" 的响应（#2264）。
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// 网络、代理与 fetch 传输层失败。包括 OpenAI Codex 的原始 fetch
	// 失败，如 "upstream connect"、"connection refused"、"reset before
	// headers"（#733），以及 OpenRouter 的连接掉线（#3317）。
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket 传输层可能上报 close/error 文本而非 HTTP/fetch 文本。
	"websocket.?closed",
	"websocket.?error",

	// SDK 与传输层的流过早结束。Anthropic 可能抛出 "stream ended without
	// ..." 和 "Anthropic stream ended before message_stop"（#4433）；
	// Bedrock/Smithy 可能抛出 HTTP/2 无响应错误（#3594）。
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	// Node 的 ERR_HTTP2_STREAM_CANCEL：HTTP/2 会话在请求发出前就死了，
	// 例如 Bedrock SDK 的 5 分钟会话超时之后（#10379）。
	"pending stream has been canceled",

	// 提供商要求的重试延迟超过上限的情形应流入外层重试策略，
	// 让调用方能够展示/中止退避（#1123）。
	"retry delay",

	// OpenAI Responses 与 Bedrock 流异常在流中途发出的显式重试指引（#6019）。
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// 基于 gRPC 的提供商（例如 NVIDIA NIM）
	"ResourceExhausted",

	// 使用 ChatGPT 登录：用量或用户数据暂时不可用。用量失败可能在流中途
	// 到达，消息里没有 HTTP 503。
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

/**
 * 重试策略：有界的尝试次数与指数退避（`baseDelayMs * 2^(attempt-1)`）。
 * `maxAgentDelayMs` 限制每次计算出的延迟，默认 60 秒。
 * 与 coding-agent 的 `settings.retry`（`enabled`、`maxRetries`、`baseDelayMs`、`maxAgentDelayMs`）保持一致；
 * 放在这里是为了让分类器和策略驱动的重试循环同处一处，并保持可被
 * SDK 及其他调用方复用。
 */
export interface RetryPolicy {
	enabled: boolean;
	/** 最大重试次数（0 = 不重试）。首次调用不计为重试。 */
	maxRetries: number;
	/** 基础延迟（毫秒）。加抖动前单次尝试延迟为 `baseDelayMs * 2^(attempt-1)`。 */
	baseDelayMs: number;
	/** 可选的 agent 级重试延迟上限（毫秒）。默认 60 秒。 */
	maxAgentDelayMs?: number;
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

/** {@link retryAssistantCall} 在每次重试前后触发的可选回调。 */
export interface RetryCallbacks {
	/** 在每次重试尝试（从 1 计数）的退避休眠前触发。 */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** 在退避休眠之后、被重试的调用开始之前触发。 */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** 循环结束时触发一次：若后续某次调用正常完成则为成功。 */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * 对单次产生 assistant 结果的调用执行有界重试，以应对瞬态错误。
 *
 * 行为：
 * - 成功的响应立即返回。中止是终态的，绝不重试；但如果中止发生在某次重试
 *   已被调度之后，会以“不成功”上报。退避休眠期间的中止同样会被规范化为
 *   已中止的 `AssistantMessage`，因此调用方无需关心取消发生的时机。
 * - 不可重试的错误（依据 {@link isRetryableAssistantError}，包括配额/
 *   计费耗尽）立即返回，让确定性错误快速失败。
 * - 否则以指数退避最多重试 `maxRetries` 次：每次休眠前触发
 *   `onRetryScheduled`，每次休眠后、被重试的调用开始前触发
 *   `onRetryAttemptStart`，并在循环结束（无论结局是成功、重试耗尽还是
 *   退避被中止）时触发一次 `onRetryFinished`。
 *
 * 当 `policy` 为 undefined 或未启用时，首个响应原样返回
 * （等价于直接调用 `produce()`）。
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// 中止：终态但不算成功。绝不重试已中止的消息。
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// 成功：非错误、非中止的响应原样返回。
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// 不可重试，或额度耗尽：返回最终错误消息。
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = retryDelayMs(policy!, attempt);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// 将重试退避期间的中止规范化为与提供商流中止一致的 AssistantMessage 形态，
		// 这样调用方无需关心取消发生的时机。
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				const { errorMessage: _errorMessage, ...rest } = response;
				return { ...rest, stopReason: "aborted" };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * 判断一条失败的 assistant 消息是否像是瞬态的提供商或传输层错误，
 * 供调用方决定是否应重启最后一个 assistant 回合。
 *
 * 这里不实现重试策略。调用方应先单独处理上下文溢出，
 * 再按自身的重试预算、退避与上报逻辑处理后重启 assistant 回合。
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
