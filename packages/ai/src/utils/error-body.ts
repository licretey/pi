// 提供商 HTTP 错误对象的共享规范化处理。
//
// 位于代理 / 网关之后的端点可能返回非 2xx 响应，其响应体无法被提供商 SDK
// 折叠进 `error.message`。SDK 错误对象仍然携带 HTTP 状态码以及原始/已解析
// 的响应体，但字段名因 SDK 而异。只读取 `error.message` 的提供商 catch 块
// 因此会丢弃响应体，暴露出诸如 `"403 status code (no body)"` 这样难以理解
// 的消息，或退化为 `"Unknown: UnknownError"`。
//
// `normalizeProviderError` 探测已知的 SDK 字段形态（Mistral、`openai`、
// `@google/genai`、AWS Bedrock），返回一个结构体，供各提供商拼装成自己的
// 展示字符串。`messageCarriesBody` 标志覆盖了 Anthropic / `@google/genai`
// 的正常路径：SDK 已将响应体折叠进 message，提供商可以直接保留而不会重复打印。

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	/** HTTP 状态码；仅当能从 SDK 错误对象中提取到时才存在。 */
	status?: number;
	/** 原始 HTTP 响应体内容， 已经去除首尾空白并截断到上限。 */
	body?: string;
	/** `error.message`；抛出的不是 `Error` 时为 `safeJsonStringify(error)`。 */
	message: string;
	/** 为 true 表示 `message` 已包含响应体（无需再单独附加）。 */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

/**
 * 探测 HTTP 状态码，第一个数值命中即生效，按 SDK 字段顺序：
 * `statusCode`（Mistral）→ `status`（`openai`、`@google/genai`）→
 * `$metadata.httpStatusCode`（Bedrock）→ `$response.statusCode`（Bedrock）。
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * 探测原始响应体内容，第一个可用命中即生效，按 SDK 字段顺序：
 * `body` 字符串（Mistral）→ `error` 已解析的 JSON 响应体对象（`openai` SDK 的
 * `this.error`）→ `$response.body`（Bedrock）。空对象和未读取的响应流视为
 * 没有响应体，以免以 `"{}"` 或序列化的流内部结构出现在展示信息里。选定的
 * 响应体会截断到上限。
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * 只有「普通」对象才算 HTTP 响应体。SDK 错误字段里可能装着类实例而非已解析
 * 的响应体 —— AWS SDK v3 的 `$response.body` 是一个 HTTP 流/响应包装对象，
 * 对它做字符串化会产生诸如 `{"_events":...}` 的垃圾内容并被当作"响应体"，
 * 进而在拼装的展示字符串中【替换掉】`error.message`。而 `error.message` 正
 * 是 SDK 放置真实反序列化异常文本的地方（"Input is too long..."、模式校验
 * 详情等），唯一有用的字符串就这样被噪音丢弃了。类实例不会产出响应体，
 * `messageCarriesBody` 保持为 true，真实消息得以保留。这是对上面 `pipe`
 * 嗅探的补充：Web ReadableStream（pipeTo/pipeThrough，没有 `pipe`）和
 * 非流的 SDK 包装类都通不过原型检查，而已解析的 JSON 响应体（构造上就是
 * 普通对象）仍能通过。
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * 由规范化后的错误拼装展示字符串。当 message 已经携带响应体
 * （Anthropic / `@google/genai` 的正常路径）、或未能提取到响应体/状态码时，
 * 原样返回 message。否则展示状态码和响应体，可带一个提供商前缀。
 *
 * - 无前缀：`"<status>: <body>"`
 * - 有前缀：`"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
