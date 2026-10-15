import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import {
	isJsonRpcRequest,
	isJsonRpcResponse,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcMessage,
	McpConnectionClosedError,
	parseJsonRpcMessage,
	toError,
} from "../protocol/jsonrpc.ts";
import { DEFAULT_MAX_MESSAGE_BYTES, type McpTransport, TransportEvents } from "./transport.ts";

const MAX_ERROR_BODY_BYTES = 8 * 1024;
const ERROR_MESSAGE_BODY_CHARS = 500;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_MAX_RETRIES = 5;

export interface SseEvent {
	event?: string;
	data: string;
	id?: string;
}

export interface ConsumeSseOptions {
	maxEventBytes?: number;
	onEvent(event: SseEvent): void;
	/** 每次遇到 `id` 字段时调用，包括没有数据的事件（例如用于启动恢复流程的事件）。 */
	onId?(id: string): void;
	/** 每次遇到有效的 `retry` 字段时调用，参数单位为毫秒。 */
	onRetry?(delayMs: number): void;
}

export async function consumeSseStream(stream: ReadableStream<Uint8Array>, options: ConsumeSseOptions): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let eventName: string | undefined;
	let eventId: string | undefined;
	let dataLines: string[] = [];
	// 统计待处理事件数据的字节数，包括各行之间的 "\n"，避免没有结束空行且包含大量短 `data:` 行的事件无限增长。
	let dataBytes = 0;
	const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

	const dispatch = () => {
		if (dataLines.length === 0) {
			eventName = undefined;
			eventId = undefined;
			return;
		}
		const data = dataLines.join("\n");
		options.onEvent({ ...(eventName ? { event: eventName } : {}), data, ...(eventId ? { id: eventId } : {}) });
		eventName = undefined;
		eventId = undefined;
		dataLines = [];
		dataBytes = 0;
	};

	const processLine = (rawLine: string) => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") {
			dispatch();
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			dataBytes += Buffer.byteLength(value) + (dataLines.length > 0 ? 1 : 0);
			if (dataBytes > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
			dataLines.push(value);
		} else if (field === "event") eventName = value;
		else if (field === "id" && !value.includes("\0")) {
			eventId = value;
			options.onId?.(value);
		} else if (field === "retry" && /^\d+$/.test(value)) options.onRetry?.(Number(value));
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				processLine(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
			}
			if (Buffer.byteLength(buffered) > maxEventBytes)
				throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
		}
		buffered += decoder.decode();
		if (buffered) processLine(buffered);
		dispatch();
	} finally {
		reader.releaseLock();
	}
}

export interface StreamableHttpReconnectOptions {
	/** 首次尝试重新连接前的等待时间；若服务器发送了 `retry` 字段，则以该字段为准。默认值：1000。 */
	initialDelayMs?: number;
	/** 指数退避等待时间的上限。默认值：30000。 */
	maxDelayMs?: number;
	/** 放弃数据流前允许连续失败的次数。默认值：5。 */
	maxRetries?: number;
}

export interface StreamableHttpTransportOptions {
	url: string | URL;
	headers?: Record<string, string>;
	fetch?: McpFetch;
	/** 初始化后是否打开服务器到客户端的 GET 数据流。默认值：true。 */
	openGetStream?: boolean;
	maxMessageBytes?: number;
	authProvider?: AuthProvider;
	/** 是否重新连接意外断开的 SSE 数据流（GET 数据流，以及携带事件 ID 的响应数据流）。 */
	reconnect?: StreamableHttpReconnectOptions;
}

export class McpHttpError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, message: string, body = "") {
		super(message);
		this.name = "McpHttpError";
		this.status = status;
		this.body = body;
	}
}

export class McpAuthRequiredError extends McpHttpError {
	readonly wwwAuthenticate: string | null;

	constructor(response: Response, body = "") {
		super(401, "MCP server requires authentication", body);
		this.name = "McpAuthRequiredError";
		this.wwwAuthenticate = response.headers.get("www-authenticate");
	}
}

export class McpSessionExpiredError extends McpHttpError {
	constructor(body = "") {
		super(404, "MCP session expired", body);
		this.name = "McpSessionExpiredError";
	}
}

function contentType(response: Response): string | undefined {
	return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

/** 状态码为 401，或状态码为 403 且 Bearer challenge 为 `insufficient_scope`（需要提升授权范围）。 */
function needsAuthorization(response: Response): boolean {
	if (response.status === 401) return true;
	if (response.status !== 403) return false;
	return /(?:^|[\s,])error="?insufficient_scope"?/i.test(response.headers.get("www-authenticate") ?? "");
}

/** 数据流无法打开或重新打开时值得重试的状态码。 */
function isTransientStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function discard(response: Response): Promise<void> {
	return response.body?.cancel().catch(() => {}) ?? Promise.resolve();
}

function describeHttpFailure(status: number, body: string): string {
	const text = body.trim();
	const snippet = text.length > ERROR_MESSAGE_BODY_CHARS ? `${text.slice(0, ERROR_MESSAGE_BODY_CHARS - 3)}...` : text;
	return `MCP HTTP request failed with status ${status}${snippet ? `: ${snippet}` : ""}`;
}

interface StreamCursor {
	lastEventId: string | undefined;
	retryMs: number | undefined;
	/** 数据流打开或重新打开后，是否已传递过事件。 */
	received: boolean;
}

export class StreamableHttpTransport extends TransportEvents implements McpTransport {
	readonly url: URL;
	readonly options: Readonly<StreamableHttpTransportOptions>;
	private fetch: McpFetch;
	private controller = new AbortController();
	private started = false;
	private closed = false;
	private sessionIdValue: string | undefined;
	private protocolVersion: string | undefined;
	private getStreamStarted = false;
	/** 最近一次请求使用的访问令牌；`close()` 会复用此令牌，而不会再次向身份验证提供程序请求令牌。 */
	private lastToken: string | undefined;

	constructor(options: StreamableHttpTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
		this.url = new URL(options.url);
		const fetch = options.fetch ?? globalThis.fetch;
		// 调用 fetch 时不绑定接收对象。`this.fetch(...)` 和 `context.fetch(...)` 会将传输对象或认证上下文作为 `this`，
		// Cloudflare Workers 的平台 fetch 会因此拒绝调用（"Illegal invocation"）。
		this.fetch = (input, init) => fetch(input, init);
	}

	get sessionId(): string | undefined {
		return this.sessionIdValue;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP Streamable HTTP transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
	}

	setProtocolVersion(version: string): void {
		this.protocolVersion = version;
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		const response = await this.authorizedFetch("POST", {
			headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
			body: JSON.stringify(message),
		});
		await this.checkResponse(response);
		this.captureSession(response);

		if (!isJsonRpcRequest(message)) {
			// 通知和响应以 202 确认且不携带回复，因此忽略响应正文。
			await discard(response);
			// 只有会话初始化完成后，服务器到客户端的数据流才能打开。
			if ("method" in message && message.method === "notifications/initialized") this.startGetStream();
			return;
		}
		if (response.status === 202 || response.status === 204) {
			throw new McpHttpError(response.status, `MCP server accepted request ${message.method} without a response`);
		}
		const type = contentType(response);
		if (type === "application/json") {
			const body: unknown = await response.json();
			for (const item of Array.isArray(body) ? body : [body]) this.emitMessage(parseJsonRpcMessage(item));
			return;
		}
		if (type === "text/event-stream" && response.body) {
			void this.consumeResponseStream(response.body, message.id);
			return;
		}
		await discard(response);
		throw new McpHttpError(response.status, `Unsupported MCP response content type: ${type ?? "missing"}`);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		if (this.started && this.sessionIdValue) {
			// 尽力关闭即可：会话最终会在服务器端过期。认证提供方可能通过网络刷新令牌，
			// 因此关闭时不调用它，也不会等待令牌刷新完成。
			try {
				const response = await this.fetch(this.url, {
					method: "DELETE",
					headers: this.buildHeaders({}, this.lastToken),
					signal: AbortSignal.timeout(1_000),
				});
				await discard(response);
			} catch {}
		}
		this.emitClose();
	}

	/**
	 * 添加认证标头后发起 fetch。遇到 401（或要求更多 scope 的 403）时，会将响应交给认证提供方处理一次，
	 * 然后使用更新后的凭据重试请求。
	 */
	private async authorizedFetch(
		method: "GET" | "POST",
		init: { headers: Record<string, string>; body?: string },
	): Promise<Response> {
		const onUnauthorized = this.options.authProvider?.onUnauthorized?.bind(this.options.authProvider);
		for (let attempt = 0; ; attempt++) {
			const { headers, token } = await this.headers(init.headers);
			const response = await this.fetch(this.url, {
				method,
				headers,
				body: init.body,
				signal: this.controller.signal,
			});
			if (attempt > 0 || !onUnauthorized || !needsAuthorization(response)) return response;
			try {
				await onUnauthorized({ response, serverUrl: this.url, fetch: this.fetch, token });
			} finally {
				await discard(response);
			}
		}
	}

	private async headers(extra: Record<string, string> = {}): Promise<{ headers: Headers; token?: string }> {
		const token = await this.options.authProvider?.token();
		this.lastToken = token;
		return { headers: this.buildHeaders(extra, token), ...(token ? { token } : {}) };
	}

	private buildHeaders(extra: Record<string, string>, token: string | undefined): Headers {
		const headers = new Headers(this.options.headers);
		for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		if (this.sessionIdValue) headers.set("Mcp-Session-Id", this.sessionIdValue);
		if (this.protocolVersion) headers.set("MCP-Protocol-Version", this.protocolVersion);
		if (token) headers.set("Authorization", `Bearer ${token}`);
		return headers;
	}

	private captureSession(response: Response): void {
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.sessionIdValue = sessionId;
	}

	private async checkResponse(response: Response): Promise<void> {
		if (response.ok) return;
		const body = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY_BYTES);
		if (response.status === 401) throw new McpAuthRequiredError(response, body);
		if (response.status === 404 && this.sessionIdValue) throw new McpSessionExpiredError(body);
		throw new McpHttpError(response.status, describeHttpFailure(response.status, body), body);
	}

	private async consumeSse(
		stream: ReadableStream<Uint8Array>,
		cursor: StreamCursor,
		onMessage?: (message: JsonRpcMessage) => void,
	): Promise<void> {
		await consumeSseStream(stream, {
			maxEventBytes: this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
			onId: (id) => {
				cursor.lastEventId = id;
			},
			onRetry: (delayMs) => {
				cursor.retryMs = delayMs;
			},
			onEvent: (event) => {
				cursor.received = true;
				// 无数据事件用于初始化恢复机制；其他事件类型不属于 JSON-RPC。
				if (!event.data.trim() || (event.event !== undefined && event.event !== "message")) return;
				let message: JsonRpcMessage;
				try {
					message = parseJsonRpcMessage(JSON.parse(event.data));
				} catch (error) {
					this.emitError(error);
					return;
				}
				onMessage?.(message);
				this.emitMessage(message);
			},
		});
	}

	/**
	 * 读取用于响应单个请求的 SSE 数据流。如果响应到达前数据流结束或中断，且服务器分配了事件 ID，
	 * 则使用 GET 和 `Last-Event-ID` 恢复读取，因为服务器可以随时关闭响应流。否则仅当前请求失败。
	 */
	private async consumeResponseStream(body: ReadableStream<Uint8Array>, requestId: JsonRpcId): Promise<void> {
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
		let answered = false;
		const onMessage = (message: JsonRpcMessage) => {
			if (isJsonRpcResponse(message) && message.id === requestId) answered = true;
		};
		let stream: ReadableStream<Uint8Array> | undefined = body;
		let failure: unknown;
		for (let attempt = 0; ; ) {
			if (stream) {
				try {
					await this.consumeSse(stream, cursor, onMessage);
					failure = undefined;
				} catch (error) {
					failure = error;
				}
			}
			if (answered || this.closed) return;
			if (failure !== undefined && !this.isRetryable(failure)) break;
			if (cursor.lastEventId === undefined || attempt >= this.maxRetries()) break;
			if (cursor.received) attempt = 0;
			cursor.received = false;
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
			try {
				stream = await this.openSseStream(cursor.lastEventId);
			} catch (error) {
				failure = error;
				if (!this.isRetryable(error)) break;
				stream = undefined;
			}
		}
		if (this.closed) return;
		const reason = failure === undefined ? "stream ended without a response" : toError(failure).message;
		this.emitMessage({
			jsonrpc: "2.0",
			id: requestId,
			error: { code: JSON_RPC_ERROR_CODES.internalError, message: `MCP response stream failed: ${reason}` },
		});
	}

	private startGetStream(): void {
		if (this.options.openGetStream === false || this.getStreamStarted || this.closed) return;
		this.getStreamStarted = true;
		void this.runGetStream();
	}

	/** 保持服务器到客户端的数据流开启；连接中断时按退避策略重连。 */
	private async runGetStream(): Promise<void> {
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
		for (let attempt = 0; !this.closed; ) {
			try {
				const stream = await this.openSseStream(cursor.lastEventId);
				// 服务器不支持 GET 数据流。
				if (!stream) return;
				const openedAt = Date.now();
				await this.consumeSse(stream, cursor);
				// 数据流保持一段时间后即视为健康，即使期间没有活动也一样。
				if (cursor.received || Date.now() - openedAt > this.maxDelay()) attempt = 0;
			} catch (error) {
				if (this.closed) return;
				if (!this.isRetryable(error)) {
					this.emitError(error);
					return;
				}
			}
			cursor.received = false;
			if (attempt >= this.maxRetries()) {
				this.emitError(new Error("MCP server-to-client stream dropped and could not be reopened"));
				return;
			}
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
		}
	}

	/** 打开 GET SSE 数据流。服务器返回 405（不支持 GET 数据流）时，解析结果为 undefined。 */
	private async openSseStream(lastEventId: string | undefined): Promise<ReadableStream<Uint8Array> | undefined> {
		const response = await this.authorizedFetch("GET", {
			headers: {
				accept: "text/event-stream",
				...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
			},
		});
		if (response.status === 405) {
			await discard(response);
			return undefined;
		}
		await this.checkResponse(response);
		this.captureSession(response);
		const type = contentType(response);
		if (type !== "text/event-stream" || !response.body) {
			await discard(response);
			throw new McpHttpError(response.status, `Unsupported MCP GET response content type: ${type ?? "missing"}`);
		}
		return response.body;
	}

	/**
	 * 网络故障和临时状态码会触发重试；认证、会话和协议错误不会重试。
	 * `fetch` 会将网络故障（包括响应正文传输中连接断开）报告为 `TypeError`。
	 */
	private isRetryable(error: unknown): boolean {
		if (error instanceof McpHttpError) return isTransientStatus(error.status);
		if (error instanceof TypeError) return true;
		const code = (error as { code?: unknown } | undefined)?.code;
		return typeof code === "string" && (code.startsWith("E") || code.startsWith("UND_ERR"));
	}

	private reconnectDelay(attempt: number, serverDelayMs: number | undefined): number {
		if (serverDelayMs !== undefined) return serverDelayMs;
		const initial = this.options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
		return Math.min(initial * 2 ** attempt, this.maxDelay());
	}

	private maxDelay(): number {
		return this.options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
	}

	private maxRetries(): number {
		return this.options.reconnect?.maxRetries ?? DEFAULT_RECONNECT_MAX_RETRIES;
	}

	/** 等待期间传输已关闭时，解析结果为 false。 */
	private sleep(ms: number): Promise<boolean> {
		const signal = this.controller.signal;
		if (signal.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			const onAbort = () => {
				clearTimeout(timer);
				resolve(false);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve(true);
			}, ms);
			// 仅等待重连不会阻止进程退出。
			timer.unref?.();
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}
