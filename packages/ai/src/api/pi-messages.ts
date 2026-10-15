/**
 * pi-messages API 实现。
 *
 * 将 pi 自有的消息协议直接流式发送到后端：请求是向 `<baseUrl>/messages` 发送一次包含 `{ model, context, options }` 的 POST，
 * 响应则是 SSE 数据流，其中包含序列化的 assistant 消息事件以及终态 `done`/`error` 事件。
 * Radius 网关使用此通信协议；任何实现了该协议的后端也都可以使用，例如通过 models.json 中
 * `"api": "pi-messages"` 的自定义提供商接入。
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	CacheRetention,
	JsonObject,
	JsonValue,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ThinkingLevel,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export interface PiMessagesOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	/** 向后端请求调试元数据（例如路由响应头）。 */
	debug?: boolean;
}

type PiMessagesUsage = AssistantMessage["usage"];
type PiMessagesStopReason = AssistantMessage["stopReason"];

/** 服务端改写消息的影响摘要（例如网关策略导致的改写）。 */
export type PiMessagesRewriteImpact = {
	policyId: string;
	policyVersion: number;
	changed: boolean;
	tokenCountChange: number;
	messageCountChange: number;
	systemPromptChanged: boolean;
};

/** pi-messages 后端发送的序列化 assistant-message 事件。 */
export type PiMessagesEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			contentSignature?: string;
			redacted?: boolean;
	  }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| {
			type: "done";
			reason: Extract<PiMessagesStopReason, "stop" | "length" | "toolUse">;
			usage: PiMessagesUsage;
			responseId?: string;
			providerThinkingLevel?: string;
			rewrite?: PiMessagesRewriteImpact;
	  }
	| {
			type: "error";
			reason: Extract<PiMessagesStopReason, "aborted" | "error">;
			usage: PiMessagesUsage;
			errorMessage?: string;
			responseId?: string;
			providerThinkingLevel?: string;
			rewrite?: PiMessagesRewriteImpact;
	  };

type PiMessagesErrorBody = {
	error?: {
		message?: unknown;
		code?: unknown;
		details?: unknown;
		[key: string]: unknown;
	};
};

export class PiMessagesResponseError extends Error {
	code?: string;
	readonly diagnosticDetails: JsonObject;

	constructor(message: string, code: string | undefined, diagnosticDetails: JsonObject) {
		super(message);
		this.name = "PiMessagesResponseError";
		this.code = code;
		this.diagnosticDetails = diagnosticDetails;
	}
}

function parsePiMessagesErrorBody(body: string): PiMessagesErrorBody | undefined {
	try {
		const parsed = JSON.parse(body) as PiMessagesErrorBody | null;
		const error = parsed?.error;
		return parsed && typeof error === "object" && error !== null && !Array.isArray(error) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function truncateDiagnosticString(value: string): string {
	const maxLength = 8192;
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function formatPiMessagesResponseError(
	response: Response,
	body: string,
	errorBody: PiMessagesErrorBody | undefined,
): string {
	const message = typeof errorBody?.error?.message === "string" ? errorBody.error.message : undefined;
	const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : undefined;
	const suffix = message ?? body;
	const codeSuffix = code ? ` (${code})` : "";
	return `${response.status} ${response.statusText}: ${suffix}${codeSuffix}`;
}

function createPiMessagesResponseError(
	model: Model<"pi-messages">,
	url: URL,
	response: Response,
	body: string,
): PiMessagesResponseError {
	const errorBody = parsePiMessagesErrorBody(body);
	const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : undefined;
	return new PiMessagesResponseError(formatPiMessagesResponseError(response, body, errorBody), code, {
		version: 1,
		provider: model.provider,
		model: model.id,
		url: url.toString(),
		status: response.status,
		statusText: response.statusText,
		...(errorBody?.error === undefined ? {} : { error: errorBody.error as JsonValue }),
		...(errorBody ? {} : { body: truncateDiagnosticString(body) }),
		timestampMs: Date.now(),
	});
}

function createEmptyUsage(): PiMessagesUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function appendRewriteDiagnostic(message: AssistantMessage, rewrite: PiMessagesRewriteImpact | undefined): void {
	if (!rewrite) {
		return;
	}
	appendAssistantMessageDiagnostic(message, {
		type: "pi_messages_rewrite",
		timestamp: Date.now(),
		details: { ...rewrite },
	});
}

function createEventConverter(model: Model<"pi-messages">) {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const toolJson = new Map<number, string>();

	return (event: PiMessagesEvent): AssistantMessageEvent => {
		switch (event.type) {
			case "done":
				Object.assign(partial, {
					stopReason: event.reason,
					usage: event.usage,
					responseId: event.responseId,
				});
				if (event.providerThinkingLevel !== undefined) {
					partial.providerThinkingLevel = event.providerThinkingLevel;
				}
				appendRewriteDiagnostic(partial, event.rewrite);
				return { type: "done", reason: event.reason, message: partial };
			case "error":
				Object.assign(partial, {
					stopReason: event.reason,
					usage: event.usage,
					errorMessage: event.errorMessage,
					responseId: event.responseId,
				});
				if (event.providerThinkingLevel !== undefined) {
					partial.providerThinkingLevel = event.providerThinkingLevel;
				}
				appendRewriteDiagnostic(partial, event.rewrite);
				return { type: "error", reason: event.reason, error: partial };
			case "start":
				break;
			case "text_start":
				partial.content[event.contentIndex] = { type: "text", text: "" };
				break;
			case "text_delta":
				(partial.content[event.contentIndex] as { text: string }).text += event.delta;
				break;
			case "text_end":
				Object.assign(partial.content[event.contentIndex]!, {
					text: event.content,
					textSignature: event.contentSignature,
				});
				break;
			case "thinking_start":
				partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				(partial.content[event.contentIndex] as { thinking: string }).thinking += event.delta;
				break;
			case "thinking_end":
				Object.assign(partial.content[event.contentIndex]!, {
					thinking: event.content,
					thinkingSignature: event.contentSignature,
					redacted: event.redacted,
				});
				break;
			case "toolcall_start":
				partial.content[event.contentIndex] = {
					type: "toolCall",
					id: event.id,
					name: event.toolName,
					arguments: {},
				};
				toolJson.set(event.contentIndex, "");
				break;
			case "toolcall_delta": {
				const json = `${toolJson.get(event.contentIndex) ?? ""}${event.delta}`;
				toolJson.set(event.contentIndex, json);
				(partial.content[event.contentIndex] as ToolCall).arguments =
					parseStreamingJson<ToolCall["arguments"]>(json);
				break;
			}
			case "toolcall_end":
				Object.assign(partial.content[event.contentIndex]!, event.toolCall);
				toolJson.delete(event.contentIndex);
				return {
					type: "toolcall_end",
					contentIndex: event.contentIndex,
					toolCall: partial.content[event.contentIndex] as ToolCall,
					partial,
				};
		}

		return { ...event, partial } as AssistantMessageEvent;
	};
}

async function* readPiMessagesEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<PiMessagesEvent> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");

			let split = buffer.indexOf("\n\n");
			while (split !== -1) {
				const event = parsePiMessagesEvent(buffer.slice(0, split));
				if (event) {
					yield event;
				}
				buffer = buffer.slice(split + 2);
				split = buffer.indexOf("\n\n");
			}

			if (done) {
				break;
			}
		}

		if (buffer.trim()) {
			const event = parsePiMessagesEvent(buffer);
			if (event) {
				yield event;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parsePiMessagesEvent(raw: string): PiMessagesEvent | undefined {
	const data = raw
		.split("\n")
		.find((line) => line.startsWith("data:"))
		?.slice(5)
		.trim();

	return data && data !== "[DONE]" ? (JSON.parse(data) as PiMessagesEvent) : undefined;
}

function createErrorEvent(model: Model<"pi-messages">, error: unknown, aborted: boolean): AssistantMessageEvent {
	const reason = aborted ? "aborted" : "error";
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: reason,
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};

	if (!aborted && error instanceof PiMessagesResponseError) {
		appendAssistantMessageDiagnostic(
			assistantMessage,
			createAssistantMessageDiagnostic("pi_messages_response_failure", error, error.diagnosticDetails),
		);
	}

	return { type: "error", reason, error: assistantMessage };
}

function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention | undefined {
	if (cacheRetention) {
		return cacheRetention;
	}
	// 未设置时使用后端默认值；这里只映射旧版环境变量中的显式启用选项。
	return getProviderEnvValue("PI_CACHE_RETENTION", env) === "long" ? "long" : undefined;
}

export const stream: StreamFunction<"pi-messages", PiMessagesOptions> = (
	model: Model<"pi-messages">,
	context: TranscriptContext,
	options?: PiMessagesOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();
	const convertEvent = createEventConverter(model);

	void (async () => {
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key provided for provider "${model.provider}"`);
			}

			const url = new URL(`${model.baseUrl.replace(/\/+$/u, "")}/messages`);
			if (options?.debug) {
				url.searchParams.set("debug", "1");
			}

			let payload: unknown = {
				model: model.id,
				context,
				options: {
					temperature: options?.temperature,
					maxTokens: options?.maxTokens,
					reasoning: options?.reasoning,
					cacheRetention: resolveCacheRetention(options?.cacheRetention, options?.env),
					sessionId: options?.sessionId,
					toolChoice: options?.toolChoice,
				},
			};
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload;
			}

			const response = await (options?.fetch ?? globalThis.fetch)(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					accept: "text/event-stream",
					"content-type": "application/json",
					...providerHeadersToRecord(options?.headers),
				},
				body: JSON.stringify(payload),
				signal: options?.signal,
			});

			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			if (!response.ok) {
				const body = await response.text();
				throw createPiMessagesResponseError(model, url, response, body);
			}
			if (!response.body) {
				throw new Error(`${model.provider} response has no body`);
			}

			for await (const piEvent of readPiMessagesEvents(response.body)) {
				await options?.onProviderStreamEvent?.(piEvent, model);
				const event = convertEvent(piEvent);
				eventStream.push(event);
				if (event.type === "done" || event.type === "error") {
					return;
				}
			}

			throw new Error(`${model.provider} stream ended without a terminal event`);
		} catch (error) {
			eventStream.push(createErrorEvent(model, error, options?.signal?.aborted ?? false));
		}
	})();

	return eventStream;
};

export const streamSimple: StreamFunction<"pi-messages", SimpleStreamOptions> = (
	model: Model<"pi-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const extra = options as PiMessagesOptions | undefined;
	return stream(model, context, {
		...options,
		reasoning: options?.reasoning,
		toolChoice: options?.toolChoice,
		debug: extra?.debug,
	});
};
