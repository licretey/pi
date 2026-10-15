import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type {
	BetaInputTransformation,
	BetaStopReason,
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	BetaContentBlockParam as ContentBlockParam,
	MessageCreateParamsStreaming,
	BetaMessageParam as MessageParam,
	BetaRawMessageStreamEvent as RawMessageStreamEvent,
	BetaRefusalStopDetails as RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import {
	ANTHROPIC_FEDERATION_RULE_ID_ENV,
	ANTHROPIC_IDENTITY_TOKEN_FILE_ENV,
	ANTHROPIC_ORGANIZATION_ID_ENV,
	ANTHROPIC_SERVICE_ACCOUNT_ID_ENV,
	ANTHROPIC_WORKSPACE_ID_ENV,
} from "../env-api-keys.ts";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	ImageContent,
	Message,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
	getCurrentTools,
	getInitialSystemMessage,
	resolveTranscript,
	type TranscriptContext,
} from "../utils/transcript.ts";

import {
	getJsonSchemaToolParameters,
	resolveJsonSchemaStrictSampling,
	type UnsupportedStrictSchemaKeywordCheck,
} from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * 解析 cache retention 偏好。
 * 默认 "short"，并使用 PI_CACHE_RETENTION 以保持向后兼容。
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// 隐身模式：完全模仿 Claude Code 的工具命名
const claudeCodeVersion = "2.1.280";

// Claude Code 2.x 工具名（规范大小写）
// 来源：https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// 更新：https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// 若工具名匹配（大小写不敏感），转换为 Claude Code 的规范大小写
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * 将 content 块转换为 Anthropic API 格式
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// 若全部是文本块，为简单起见直接返回拼接后的字符串
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// 含图片时，转换为 content 块数组
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// 只有图片（无文本）时，追加一个占位文本块
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MID_CONVERSATION_OUTPUT_CONFIG_BETA = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";

/**
 * 只要启用了原生 tool 变更，就会声明这个稳定的延迟工具。Anthropic 会为会话中途
 * 的工具变更添加隐藏的 prompt 脚手架；从首个请求就声明这个占位符，可以把该脚手架
 * 留在缓存前缀里，从而首次工具变更不会使缓存失效（实测：没有它会完全 miss）。
 * 它永远不会被激活，模型也看不到它。
 */
const DEFERRED_TOOL_PLACEHOLDER: BetaTool = {
	name: "__pi_deferred_placeholder__",
	description: "Reserved placeholder. Never available. Never call this.",
	input_schema: { type: "object", properties: {}, required: [] },
	defer_loading: true,
};

function shouldUseServerSideFallbackBeta(model: Model<"anthropic-messages">): boolean {
	return (model.compat?.allowedFallbackModels?.length ?? 0) > 0;
}

function getAnthropicCompat(model: Model<"anthropic-messages">) {
	const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? isOpenRouter,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? (isOpenRouter ? "openrouter" : undefined),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsMidConvoToolChanges: model.compat?.supportsMidConvoToolChanges ?? false,
	};
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * 启用 extended thinking。
	 * 对 adaptive thinking 模型：由模型决定何时思考、思考多少。
	 * 对较老的模型：使用基于 thinkingBudgetTokens 的预算式思考。
	 * 默认：undefined（除非 `streamSimple()` 把简单的 reasoning 等级
	 * 映射到该选项，或调用方显式设置，否则不思考）。
	 */
	thinkingEnabled?: boolean;
	/**
	 * extended thinking 的 token 预算（仅较老的模型）。
	 * 对 adaptive thinking 模型无效。
	 * 默认：`thinkingEnabled` 为 true 且未提供预算时为 1024。
	 */
	thinkingBudgetTokens?: number;
	/**
	 * adaptive thinking 模型的 effort 等级。
	 * 控制 Claude 分配多少思考：
	 * - "max"：始终思考，无任何约束（仅 Opus 4.6）
	 * - "xhigh"：最高推理档位（Opus 4.7+、Fable 5）
	 * - "high"：始终思考，深度推理
	 * - "medium"：中等思考，简单问题可能跳过
	 * - "low"：最少思考，简单任务直接跳过
	 * 对较老的模型无效。
	 * 默认：除非 `streamSimple()` 把简单的 reasoning 等级映射到
	 * 该选项，否则省略。
	 */
	effort?: AnthropicEffort;
	/**
	 * 控制思考内容在 API 响应中的返回方式。
	 * - "summarized"：thinking 块包含总结后的思考文本。
	 * - "omitted"：thinking 块返回空的 thinking 字段；加密签名仍会
	 *   随响应返回以保证多轮连续性。当 UI 不展示思考内容时用它可获得
	 *   更快的首个文本 token 时间。
	 *
	 * 注意：Anthropic API 对 Claude Opus 4.7 和 Claude Mythos Preview
	 * 的默认值是 "omitted"。这里默认 "summarized"，以保持与更早的
	 * Claude 4 系列行为一致。需要时显式设为 "omitted"。
	 * 默认：启用思考时为 "summarized"。
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * 是否为非 adaptive thinking 模型请求 interleaved thinking beta header。
	 * adaptive thinking 模型内置 interleaved thinking，因此无论此设置如何
	 * 都会跳过该 header。
	 * 默认：true。
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice 行为。字符串值映射到 Anthropic 内置选项；
	 * `{ type: "tool", name }` 强制使用指定工具。
	 * 默认：省略（Anthropic 默认行为，当前等价于 auto）。
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * 预构建的 Anthropic 客户端实例。提供后将完全跳过内部客户端构建。
	 * 用于注入共享同一 messaging API 的替代 SDK 客户端，例如 `AnthropicVertex`。
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function mergeClientHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	return mergeHeaders({ "User-Agent": getPiUserAgent() }, ...headerSources);
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function hasRequestAuth(apiKey: string | undefined, headers: ProviderHeaders | undefined): boolean {
	return (
		!!apiKey ||
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "x-api-key") ||
		hasHeader(headers, "cf-aig-authorization")
	);
}

function assertRequestAuth(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	if (!hasRequestAuth(apiKey, headers)) throw new Error(`No API key for provider: ${provider}`);
}

/**
 * 一个永不执行 SDK 自带凭据链的 Anthropic SDK 客户端
 * （ANTHROPIC_PROFILE 配置文件、federation 环境变量）。若不做此限制，
 * 每个以 `apiKey: null, authToken: null` 构建来实现 header 自带认证的客户端，
 * 都会在 pi 的认证解析器之外再解析并兑换一次 SDK 凭据。
 */
class PiAnthropic extends Anthropic {
	protected override _shouldResolveDefaultCredentials(): boolean {
		return false;
	}
}

type AnthropicFederationConfig = NonNullable<ClientOptions["config"]>;

/**
 * 由 Anthropic SDK 文档所记载的 ANTHROPIC_* 变量构成的工作负载身份
 * federation 配置；token 的兑换与刷新由 SDK 完成。
 * 仅适用于 anthropic provider（兑换端点是 Anthropic API 的端点），
 * 且仅在未解析出 key 或认证 header 时使用。
 */
function getAnthropicFederation(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
	env: ProviderEnv | undefined,
): AnthropicFederationConfig | undefined {
	if (model.provider !== "anthropic" || hasRequestAuth(apiKey, headers)) return undefined;
	const federationRuleId = getProviderEnvValue(ANTHROPIC_FEDERATION_RULE_ID_ENV, env);
	const organizationId = getProviderEnvValue(ANTHROPIC_ORGANIZATION_ID_ENV, env);
	const identityTokenFile = getProviderEnvValue(ANTHROPIC_IDENTITY_TOKEN_FILE_ENV, env);
	if (!federationRuleId || !organizationId || !identityTokenFile) return undefined;
	return {
		organization_id: organizationId,
		workspace_id: getProviderEnvValue(ANTHROPIC_WORKSPACE_ID_ENV, env),
		authentication: {
			type: "oidc_federation",
			federation_rule_id: federationRuleId,
			service_account_id: getProviderEnvValue(ANTHROPIC_SERVICE_ACCOUNT_ID_ENV, env),
			identity_token: { source: "file", path: identityTokenFile },
		},
	};
}

/**
 * SDK 会按客户端缓存 federated access token，而 pi 每个请求都会新建客户端。
 * 因此为当前 federation 配置保留一个固定客户端并负责 fetch，
 * 再通过 `withOptions()` 按请求克隆——克隆共享同一个 token 缓存。
 */
let federationClient: { key: string; fetch: typeof globalThis.fetch | undefined; client: Anthropic } | undefined;

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getAnthropicCompat(model).supportsMidConvoSystemMessages);
	const currentTools = getCurrentTools(normalizedContext.messages);

	(async () => {
		const providerThinkingLevel = model.compat?.supportsMidConvoEffort ? (options?.effort ?? "high") : undefined;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			...(providerThinkingLevel === undefined ? {} : { providerThinkingLevel }),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			let client: Anthropic;
			let isOAuth: boolean;
			let usageModel = model;
			let inputTransformations: BetaInputTransformation[] | undefined;

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey;
				const federation = getAnthropicFederation(model, apiKey, options?.headers, options?.env);
				if (!federation) assertRequestAuth(model.provider, apiKey, options?.headers);

				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(normalizedContext.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: normalizedContext.messages,
						hasImages,
					});
				}

				const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
				const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

				const created = createClient(
					model,
					apiKey,
					options?.headers,
					options?.fetch,
					copilotDynamicHeaders,
					cacheSessionId,
					federation,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			let params = buildParams(model, normalizedContext, isOAuth, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = { ...(nextParams as MessageCreateParamsStreaming), stream: true };
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const response = await retryProviderRequest(
				() => client.beta.messages.create(params, requestOptions).asResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				await options?.onProviderStreamEvent?.(event, model);
				if (event.type === "message_start") {
					output.responseId = event.message.id;
					const transformations = event.message.input_transformations;
					if (Array.isArray(transformations)) inputTransformations = transformations;
					const responseModel = event.message.model;
					if (responseModel !== model.id) output.responseModel = responseModel;
					const fallbackCost =
						responseModel === model.id
							? undefined
							: model.compat?.allowedFallbackModels?.find(
									(fallback) => fallback.provider === model.provider && fallback.model === responseModel,
								)?.cost;
					usageModel = fallbackCost ? { ...model, id: responseModel, cost: fallbackCost } : model;
					// 从 message_start 事件捕获初始 token usage
					// 确保即使流被提前中止，也拿到 input token 计数
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
					// Anthropic 不提供 total_tokens，由各分项计算
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(usageModel, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "fallback") {
						if (output.content.length > 0) {
							throw new Error("Anthropic performed an unsupported mid-output model fallback");
						}
						continue;
					}
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: event.content_block.text ?? "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: event.content_block.thinking ?? "",
							thinkingSignature: event.content_block.signature ?? "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, currentTools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson);
							// 原地收尾并剥离暂存缓冲，确保回放只携带解析后的参数。
							delete (block as { partialJson?: string }).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					const transformations = event.input_transformations;
					if (Array.isArray(transformations)) inputTransformations = transformations;
					if (event.delta.stop_reason) {
						output.rawStopReason = event.delta.stop_reason;
						const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						output.stopReason = stopReasonResult.stopReason;
						if (stopReasonResult.errorMessage) {
							output.errorMessage = stopReasonResult.errorMessage;
						}
					}
					// 只在字段存在（非 null）时更新 usage 字段。
					// 当代理在 message_delta 中省略 input_tokens 时，保留 message_start 的值。
					if (event.usage) {
						if (event.usage.input_tokens != null) {
							output.usage.input = event.usage.input_tokens;
						}
						if (event.usage.output_tokens != null) {
							output.usage.output = event.usage.output_tokens;
						}
						if (event.usage.cache_read_input_tokens != null) {
							output.usage.cacheRead = event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens != null) {
							output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
						}
						// Vercel AI Gateway 在 delta 中也携带 TTL 明细，尽管 SDK 只在 message_start 上对其声明了类型。
						const cacheCreation = (
							event.usage as typeof event.usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }
						).cache_creation;
						if (cacheCreation?.ephemeral_1h_input_tokens != null) {
							output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
						}
						// Anthropic 将 reasoning token 作为 output token 的子集上报。
						const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
						if (thinkingTokens != null) {
							output.usage.reasoning = thinkingTokens;
						}
					}
					// Anthropic 不提供 total_tokens，由各分项计算
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(usageModel, output.usage);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Anthropic stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}
			if (inputTransformations && inputTransformations.length > 0) {
				appendAssistantMessageDiagnostic(output, {
					type: "anthropic_input_transformations",
					timestamp: Date.now(),
					details: {
						transformations: inputTransformations.map((transformation) => ({
							type: transformation.type ?? undefined,
							path: transformation.path ?? undefined,
							reason: transformation.reason ?? undefined,
						})),
					},
				});
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson 只是流式暂存缓冲；绝不持久化。
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * 为 adaptive thinking 将 ThinkingLevel 映射到 Anthropic effort 档位。
 * 注意：effort "max" 在所有 adaptive thinking Claude 模型上都可用，
 * 而原生 "xhigh" 仅在 Opus 4.7/4.8、Sonnet 5、Fable 5 上可用。
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	if (!getAnthropicFederation(model, options?.apiKey, options?.headers, options?.env)) {
		assertRequestAuth(model.provider, options?.apiKey, options?.headers);
	}

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies AnthropicOptions;
	if (!options?.reasoning) {
		return stream(model, context, {
			...base,
			thinkingEnabled: false,
		} satisfies AnthropicOptions);
	}

	// adaptive thinking 模型：使用 effort 档位。
	// 较老的模型：使用基于预算的 thinking。
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// undefined 表示调用方未要求输出上限；让 helper 使用模型上限。
	// 不要在这里强行折算成 0，否则 thinking 预算会变成整个 max_tokens 值。
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
	federation?: AnthropicFederationConfig,
): { client: Anthropic; isOAuthToken: boolean } {
	// Copilot：Bearer 认证。
	if (model.provider === "github-copilot") {
		const client = new PiAnthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch,
			defaultHeaders: mergeClientHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth：Bearer 认证 + Claude Code 身份 header
	if (apiKey && isOAuthToken(apiKey)) {
		const client = new PiAnthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch,
			defaultHeaders: mergeClientHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key、header 自带认证，或工作负载身份 federation。
	const compat = getAnthropicCompat(model);
	const sessionAffinityHeaders: ProviderHeaders = {};
	if (sessionId && compat.sendSessionAffinityHeaders) {
		const header = compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity";
		sessionAffinityHeaders[header] = sessionId;
	}
	const defaultHeaders = mergeClientHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		sessionAffinityHeaders,
		model.headers,
		optionsHeaders,
	);
	if (federation) {
		const key = JSON.stringify([model.baseUrl, federation]);
		if (federationClient?.key !== key || federationClient.fetch !== fetch) {
			const client = new PiAnthropic({
				apiKey: null,
				authToken: null,
				config: federation,
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
				fetch,
			});
			federationClient = { key, fetch, client };
		}
		return { client: federationClient.client.withOptions({ defaultHeaders }), isOAuthToken: false };
	}

	const client = new PiAnthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders,
	});

	return { client, isOAuthToken: false };
}

function getBetaFeatures(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	isOAuthToken: boolean,
	nativeToolChanges: boolean,
	options?: AnthropicOptions,
): NonNullable<MessageCreateParamsStreaming["betas"]> {
	let configuredFeatures: string | null | undefined;
	for (const headers of [model.headers, options?.headers]) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() === "anthropic-beta") configuredFeatures = value;
		}
	}
	if (configuredFeatures === null) return [];
	if (configuredFeatures !== undefined) {
		return [
			...new Set(
				configuredFeatures
					.split(",")
					.map((feature) => feature.trim())
					.filter((feature) => feature.length > 0),
			),
		];
	}

	const features: NonNullable<MessageCreateParamsStreaming["betas"]> = [];
	if (isOAuthToken) features.push("claude-code-20250219", "oauth-2025-04-20");
	if (shouldUseFineGrainedToolStreamingBeta(model, context)) features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	if (
		model.reasoning &&
		options?.thinkingEnabled === true &&
		(options.interleavedThinking ?? true) &&
		model.compat?.forceAdaptiveThinking !== true
	) {
		features.push(INTERLEAVED_THINKING_BETA);
	}
	if (shouldUseServerSideFallbackBeta(model)) features.push(SERVER_SIDE_FALLBACK_BETA);
	if (model.compat?.supportsMidConvoEffort === true) {
		features.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA, THINKING_BINDING_CONTROLS_BETA);
	}
	if (nativeToolChanges) features.push(INLINE_TOOLS_BETA);
	return [...new Set(features)];
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const initialSystemText = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	const conversationMessages = initialSystemMessage ? transformedMessages.slice(1) : transformedMessages;
	// 原生 tool 变更保持请求级工具列表固定，后续每个工具都通过 `tool_addition`
	// 块按值定义，同名重定义也在其中表达。Anthropic 会拒绝"全部工具都是延后加载"
	// 的工具列表，因此必须有一个初始激活工具来锚定占位符。
	// 否则发送当前的工具列表。
	const initialTools = initialSystemMessage?.toolsAdded ?? [];
	const nativeToolChanges =
		compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges && initialTools.length > 0;
	const converted = convertMessages(
		conversationMessages,
		isOAuthToken,
		cacheControl,
		compat.allowEmptySignature,
		model.compat?.supportsMidConvoEffort === true ? model.provider : undefined,
		nativeToolChanges
			? (tools) =>
					convertTools(tools, isOAuthToken, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools)
			: undefined,
	);
	const activeEffort = options?.effort ?? "high";
	const betaFeatures = getBetaFeatures(model, context, isOAuthToken, nativeToolChanges, options);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages:
			model.compat?.supportsMidConvoEffort === true
				? insertThinkingLevelMessages(converted, activeEffort)
				: converted.messages,
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
		...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
	};

	// 对 OAuth token，必须携带 Claude Code 身份
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (initialSystemText) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(initialSystemText),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (initialSystemText) {
		// 为非 OAuth token 向 system prompt 添加 cache control
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(initialSystemText),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature 与 extended thinking 不兼容，且 Claude Opus 4.7+ 不支持。
	if (
		options?.temperature !== undefined &&
		!options?.thinkingEnabled &&
		model.compat?.supportsMidConvoEffort !== true &&
		compat.supportsTemperature
	) {
		params.temperature = options.temperature;
	}

	const toolCacheControl = compat.supportsCacheControlOnTools ? cacheControl : undefined;
	if (nativeToolChanges) {
		// 初始工具保持激活，cache breakpoint 放在最后一个工具上，随后是占位符。
		// 此后工具列表永不变化：后续工具以 `tool_addition` 块按值定义、由
		// `tool_removal` 撤回，因此缓存前缀能在每次工具变更后得以保留。
		params.tools = [
			...convertTools(
				initialTools,
				isOAuthToken,
				compat.supportsEagerToolInputStreaming,
				compat.supportsStrictTools,
				toolCacheControl,
			),
			DEFERRED_TOOL_PLACEHOLDER,
		];
	} else {
		const tools = getCurrentTools(context.messages);
		if (tools.length > 0) {
			params.tools = convertTools(
				tools,
				isOAuthToken,
				compat.supportsEagerToolInputStreaming,
				compat.supportsStrictTools,
				toolCacheControl,
			);
		}
	}

	// Managed effort 模型总是用 adaptive thinking，因此 prefix mismatch 可以
	// 直接丢弃，而不是变成持续的 400 响应。
	if (model.compat?.supportsMidConvoEffort === true) {
		params.thinking = {
			type: "adaptive",
			display: options?.thinkingDisplay ?? "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		};
		params.output_config = { effort: "high" };
	} else if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// 默认 "summarized"，让 Opus 4.7 与 Mythos Preview 表现得和
			// 更早的 Claude 4 模型一致（它们的 API 默认值也是 "summarized"）。
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				// Adaptive thinking：由 Claude 决定何时思考、思考多少。
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					params.output_config = { effort: options.effort };
				}
			} else {
				// 较老模型使用基于预算的 thinking
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
			params.thinking = { type: "disabled" };
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	const allowedFallbackModels = model.compat?.allowedFallbackModels;
	if (allowedFallbackModels && allowedFallbackModels.length > 0) {
		params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));
	}

	return params;
}

// 将 tool call ID 规范化为 Anthropic 要求的格式和长度
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertToolResult(msg: ToolResultMessage): ContentBlockParam {
	return {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content: convertContentBlocks(msg.content),
		is_error: msg.isError,
	};
}

interface ConvertedAnthropicMessages {
	messages: MessageParam[];
	assistantLevels: Map<number, AnthropicEffort>;
}

function convertMessages(
	transformedMessages: Message[],
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
	managedProvider?: string,
	/** 为原生 `tool_addition` 块转换工具定义；工具变更不是原生时为 undefined。 */
	convertToolDefinitions?: (tools: Tool[]) => BetaTool[],
): ConvertedAnthropicMessages {
	const params: MessageParam[] = [];
	const assistantLevels = new Map<number, AnthropicEffort>();
	// 稍后的 system 消息会被扣留，并直接在下一条 assistant 消息之前发出
	//（或在 transcript 末尾发出）。Anthropic 要求 `tool_result` 块紧跟其
	// `tool_use`，中间夹 system 消息会被拒绝；这也与 managed-effort 的 system
	// 消息的插入位置呼应。结果就是 transcript 里放在 user 消息之前的更新，
	// 在线上协议中会落在它之后。
	const pendingSystemMessages: MessageParam[] = [];
	const flushPendingSystemMessages = (): void => {
		params.push(...pendingSystemMessages);
		pendingSystemMessages.length = 0;
	};

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "system") {
			// 只有模型原生接受时，稍后的 system 消息才会走到这里；
			// 否则 transcript 在转换前已被折叠进开头的 system 消息。
			const text = renderSystemMessageUpdate(msg);
			const blocks: ContentBlockParam[] = [];
			if (text.length > 0) blocks.push({ type: "text", text: sanitizeSurrogates(text) });
			if (convertToolDefinitions) {
				const added = msg.toolsAdded ?? [];
				const redefined = new Set(added.map((tool) => tool.name));
				for (const tool of msg.toolsRemoved ?? []) {
					// 同名的新定义会替换旧定义，因此无需再发送移除。
					if (redefined.has(tool.name)) continue;
					blocks.push({
						type: "tool_removal",
						tool: { type: "tool_reference", name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name },
					});
				}
				for (const definition of convertToolDefinitions(added)) {
					blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
				}
			}
			if (blocks.length > 0) pendingSystemMessages.push({ role: "system", content: blocks });
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			flushPendingSystemMessages();
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking：把不透明载荷按 redacted_thinking 原样传回
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					const thinkingSignature = block.thinkingSignature;
					const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
					if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
					// 若 thinking 签名缺失/为空（例如来自被中止的流），
					// 则转换为纯文本发给 Anthropic。部分兼容 provider 会发出并
					// 接受空签名，因此允许被标记的模型保留该块。
					if (!hasThinkingSignature) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			const messageIndex = params.length;
			params.push({
				role: "assistant",
				content: blocks,
			});
			if (
				managedProvider !== undefined &&
				msg.api === "anthropic-messages" &&
				msg.provider === managedProvider &&
				isAnthropicEffort(msg.providerThinkingLevel)
			) {
				assistantLevels.set(messageIndex, msg.providerThinkingLevel);
			}
		} else if (msg.role === "toolResult") {
			// 收集所有连续的 toolResult 消息，z.ai Anthropic 端点需要这样。
			const toolResults: ContentBlockParam[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				toolResults.push(convertToolResult(transformedMessages[j] as ToolResultMessage));
				j++;
			}

			// 跳过已处理过的消息。
			i = j - 1;

			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	flushPendingSystemMessages();

	// 在最后一条 user 或 system 消息上添加 cache_control，缓存会话历史
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user" || lastMessage.role === "system") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" ||
						lastBlock.type === "image" ||
						lastBlock.type === "tool_result" ||
						lastBlock.type === "tool_addition" ||
						lastBlock.type === "tool_removal")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return { messages: params, assistantLevels };
}

function isAnthropicEffort(value: unknown): value is AnthropicEffort {
	return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function insertThinkingLevelMessages(
	converted: ConvertedAnthropicMessages,
	activeEffort: AnthropicEffort,
): MessageParam[] {
	const messages: MessageParam[] = [];
	for (let index = 0; index < converted.messages.length; index++) {
		const historicalEffort = converted.assistantLevels.get(index);
		if (historicalEffort !== undefined) {
			messages.push({ role: "system", content: [], output_config: { effort: historicalEffort } });
		}
		messages.push(converted.messages[index]);
	}
	messages.push({ role: "system", content: [], output_config: { effort: activeEffort } });
	return messages;
}

function shouldUseFineGrainedToolStreamingBeta(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
): boolean {
	return getCurrentTools(context.messages).length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

// Anthropic 严格工具调用会对包含以下关键字的整个请求返回 400。
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations
const ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"maxItems",
	"uniqueItems",
	"minContains",
	"maxContains",
	"minProperties",
	"maxProperties",
]);
const ANTHROPIC_STRICT_STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);

const isAnthropicStrictUnsupportedKeyword: UnsupportedStrictSchemaKeywordCheck = (key, value) => {
	if (ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS.has(key)) return true;
	if (key === "minItems") return value !== 0 && value !== 1;
	if (key === "format") return typeof value !== "string" || !ANTHROPIC_STRICT_STRING_FORMATS.has(value);
	return false;
};

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	supportsStrictTools: boolean,
	cacheControl?: CacheControlEphemeral,
): BetaTool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictTools, isAnthropicStrictUnsupportedKeyword);
		const parameters = getJsonSchemaToolParameters(tool, strict);
		const schema = parameters as { properties?: unknown; required?: string[] };
		const legacyInputSchema = {
			type: "object" as const,
			properties: schema.properties ?? {},
			required: schema.required ?? [],
		};
		const inputSchema =
			strict === true
				? {
						...(parameters as Record<string, unknown>),
						...legacyInputSchema,
					}
				: legacyInputSchema;

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(strict === true ? { strict: true } : {}),
			input_schema: inputSchema,
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(
	reason: BetaStopReason | string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		case "pause_turn": // 直接视为停止即可 —— 重新提交
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // 我们不提供 stop sequence，理论上不应走到这里
		case "sensitive": // 被安全过滤器标记的内容（SDK 类型中尚未收录）
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		default:
			// 优雅处理未知 stop reason（API 未来可能新增取值）
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
