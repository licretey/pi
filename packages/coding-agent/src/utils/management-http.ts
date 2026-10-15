type FetchInput = Parameters<typeof fetch>[0];

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchRetryOptions {
	/** 初次请求之后的额外重试次数。默认为两次。 */
	maxRetries?: number;
	/** 是否重试临时 HTTP 响应和传输失败。默认为 true。 */
	retryOnStatus?: boolean;
	/** 所有尝试共用的总时限。 */
	timeoutMs?: number;
	/** 单次尝试的超时时长。每次尝试都会创建新的计时器。 */
	attemptTimeoutMs?: number;
}

/**
 * 获取管理用途的 HTTP 资源，并在限定次数内立即重试。
 *
 * 此函数是传输层辅助函数，仅用于可幂等的管理请求（版本检查、目录读取和下载）。
 * 不得用于智能体或模型操作：这类操作可能在 HTTP 请求开始后失败，应由了解操作语义的调用方负责重试。
 *
 * 调用方取消和 `timeoutMs` 超时都会终止整个操作。`attemptTimeoutMs` 只会中止当前尝试，
 * 因而连接挂起时仍可重试。
 */
export async function fetchWithRetry(
	input: FetchInput,
	init: RequestInit | undefined = undefined,
	options: FetchRetryOptions = {},
): Promise<Response> {
	const maxRetries =
		options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
			? 2
			: Math.max(0, Math.floor(options.maxRetries));
	const retryOnStatus = options.retryOnStatus ?? true;
	const parentSignal = init?.signal ?? undefined;
	const timeoutSignal =
		options.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	const attemptTimeoutMs =
		options.attemptTimeoutMs !== undefined && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : undefined;

	for (let attempt = 0; ; attempt++) {
		parentSignal?.throwIfAborted();
		timeoutSignal?.throwIfAborted();
		const attemptTimeoutSignal = attemptTimeoutMs ? AbortSignal.timeout(attemptTimeoutMs) : undefined;
		const signals = [parentSignal, timeoutSignal, attemptTimeoutSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

		try {
			const response = await fetch(input, signal ? { ...init, signal } : init);
			const shouldRetry = retryOnStatus && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries;
			if (!shouldRetry) return response;
			try {
				await response.body?.cancel();
			} catch {
				// 此响应将在重试前丢弃。如果取消其响应体也失败，则无需进一步处理。
			}
		} catch (error) {
			const attemptTimedOut =
				attemptTimeoutSignal?.aborted === true && !parentSignal?.aborted && !timeoutSignal?.aborted;
			if (
				parentSignal?.aborted ||
				timeoutSignal?.aborted ||
				(error instanceof Error &&
					error.name === "AbortError" &&
					!attemptTimedOut &&
					timeoutSignal === undefined) ||
				attempt >= maxRetries
			) {
				throw error;
			}
		}
	}
}
