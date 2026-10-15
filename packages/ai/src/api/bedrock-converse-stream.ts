import type { Agent as HttpsAgent } from "node:https";
import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	BedrockRuntimeServiceException,
	StopReason as BedrockStopReason,
	type Tool as BedrockTool,
	CachePointType,
	CacheTTL,
	type ContentBlock,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamMetadataEvent,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	type ToolResultContentBlock,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { BuildMiddleware, DeserializeMiddleware, DocumentType, HttpResponse, MetadataBearer } from "@smithy/types";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	ImageContent,
	JsonObject,
	JsonValue,
	Model,
	ProviderEnv,
	ProviderResponse,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import {
	collapseSystemMessages,
	getCurrentTools,
	getInitialSystemMessage,
	type TranscriptContext,
	withoutInitialSystemMessage,
} from "../utils/transcript.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	clampReasoning,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* 见 https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html 了解支持的模型。 */
	reasoning?: ThinkingLevel;
	/* 各 thinking 等级的自定义 token 预算。覆盖默认预算。 */
	thinkingBudgets?: ThinkingBudgets;
	/* 仅 Claude 4.x 系列模型支持，见 https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * 控制 Claude 思考内容在响应中的返回方式。
	 * - "summarized"：thinking 块中包含总结后的思考文本（此处默认）。
	 * - "omitted"：思考内容被隐去，但签名仍会随响应返回
	 *   以保证多轮连续性，降低首个文本 token 的出现时间。
	 *
	 * 注意：Anthropic API 对 Claude Opus 4.8 和 Mythos Preview 的默认值是
	 * "omitted"。这里默认 "summarized"，以保持与更早的 Claude 4 系列模型
	 * 行为一致。仅对 Bedrock 上的 Claude 模型生效。
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
	/** 附着在推理请求上的键值对，用于成本分摊打标。
	 * 键：最长 64 字符，不允许 `aws:` 前缀。值：最长 256 字符。最多 50 对。
	 * 这些标签会出现在 AWS Cost Explorer 的拆分成本分摊数据中。
	 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html */
	requestMetadata?: Record<string, string>;
	/** 用于 Bedrock API key 认证的 Bearer token。
	 * 设置后绕过 SigV4 签名，改以 Authorization: Bearer <token> 方式发送。
	 * 要求该 token 对应的身份具备 `bedrock:CallWithBearerToken` IAM 权限。
	 * 通过 AWS_BEARER_TOKEN_BEDROCK 环境变量设置，或直接传入。
	 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html */
	bearerToken?: string;
}

type Block = (TextContent | ThinkingContent | ToolCall) & {
	index?: number;
	partialJson?: string;
	/** 加密 reasoning 增量的暂存缓冲区，最终合并进 `thinkingSignature`。 */
	redactedChunks?: Uint8Array[];
};

const EMPTY_TEXT_PLACEHOLDER = "<empty>";

const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";

/** 与 Anthropic API 路径对 redacted thinking 所用的占位符保持一致。 */
const REDACTED_THINKING_PLACEHOLDER = "[Reasoning redacted]";

export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: TranscriptContext,
	options: BedrockOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	// Bedrock 不支持会话中途插入 system 消息；将它们合并进开头的提示。
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream" as Api,
			provider: model.provider,
			model: model.id,
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

		const blocks = output.content as Block[];

		// 通过 pi 认证流程显式配置的 profile（`profile` 选项或存储凭据 env 中
		// 带作用域的 `AWS_PROFILE`）必须优先于环境里散置的
		// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY。SDK 默认链在 `credentials`
		// 未设置于客户端配置时本就优先使用配置的 profile。见 #6957。
		const optionsProfile = options.profile || options.env?.AWS_PROFILE;
		const config: BedrockRuntimeClientConfig = {
			profile: optionsProfile || getProviderEnvValue("AWS_PROFILE", options.env),
		};
		const configuredRegion = getConfiguredBedrockRegion(options);
		const hasAmbientConfiguredProfile = Boolean(getProviderEnvValue("AWS_PROFILE"));
		const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
		const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
			model.baseUrl,
			configuredRegion,
			hasAmbientConfiguredProfile,
		);

		// 仅在未配置 region 或环境级 AWS_PROFILE 时锁定标准 AWS Bedrock runtime 端点。
		// 这样保留了 #3402 中的自定义端点（VPC/代理），也避免 us-east-1 之类的
		// 内置目录默认值覆盖 AWS_REGION/AWS_PROFILE。
		if (useExplicitEndpoint) {
			config.endpoint = model.baseUrl;
		}

		// 解析用于 Bedrock API key 认证的 bearer token。
		const skipAuth = getProviderEnvValue("AWS_BEDROCK_SKIP_AUTH", options.env) === "1";
		const bearerToken =
			options.bearerToken ||
			options.apiKey ||
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) ||
			undefined;
		const useBearerToken = bearerToken !== undefined && !skipAuth;

		// 仅在 Node.js/Bun 环境下
		if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
			// region 解析优先级：ARN 内嵌 > 显式选项 > 环境变量 > SDK 默认链。
			// 当 model ID 是 inference profile ARN 时，从中提取 region，
			// 避免与其他服务设置的 AWS_REGION 冲突。
			const arnRegionMatch = model.id.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/);
			if (arnRegionMatch) {
				config.region = arnRegionMatch[1];
			} else if (configuredRegion) {
				config.region = configuredRegion;
			} else if (endpointRegion && useExplicitEndpoint) {
				config.region = endpointRegion;
			} else if (!hasAmbientConfiguredProfile) {
				config.region = "us-east-1";
			}

			// 支持无需认证的代理
			if (skipAuth) {
				config.credentials = {
					accessKeyId: "dummy-access-key",
					secretAccessKey: "dummy-secret-key",
				};
			}

			const credentials = getConfiguredBedrockCredentials(options.env);
			if (!skipAuth && credentials && !optionsProfile) {
				config.credentials = credentials;
			}

			const proxyUrl = resolveHttpProxyUrlForTarget(model.baseUrl, options.env);
			if (proxyUrl) {
				// Bedrock runtime 自 v3.798.0 起默认使用 NodeHttp2Handler，它基于
				// `http2` 模块，不支持 http agent。
				// 改用 NodeHttpHandler 以支持 HTTP(S) 代理 agent。
				config.requestHandler = new NodeHttpHandler({
					httpAgent: new HttpProxyAgent(proxyUrl),
					httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent,
				});
			} else if (getProviderEnvValue("AWS_BEDROCK_FORCE_HTTP1", options.env) === "1") {
				// 某些自定义端点要求 HTTP/1.1 而非 HTTP/2
				config.requestHandler = new NodeHttpHandler();
			}
		} else {
			// 非 Node 环境（浏览器）：退回 us-east-1，
			// 因为没有配置文件解析可用。
			config.region =
				configuredRegion || (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) || "us-east-1";
		}

		if (useBearerToken) {
			config.token = { token: bearerToken };
			config.authSchemePreference = ["httpBearerAuth"];
		}

		// 放在 try 之外，保证 catch 仍能把中途失败关联起来：
		// 以流事件形式送达的异常本身不带任何 HTTP 元数据。
		let responseRequestId: string | undefined;

		try {
			const supportsStrictMode = model.compat?.supportsStrictMode ?? false;
			const client = new BedrockRuntimeClient(config);
			let observedRawResponse = false;
			if (options.onResponse) {
				addResponseHeadersMiddleware(client, options.onResponse, model, () => {
					observedRawResponse = true;
				});
			}
			const customHeaders = providerHeadersToRecord(options.headers);
			if (customHeaders) {
				addCustomHeadersMiddleware(client, customHeaders);
			}
			const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env);
			const inferenceMaxTokens = options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
			const initialSystemMessage = getInitialSystemMessage(normalizedContext.messages);
			const initialSystemPrompt = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : undefined;
			let commandInput = {
				modelId: model.id,
				messages: convertMessages(normalizedContext, model, cacheRetention, options.env),
				system: buildSystemPrompt(initialSystemPrompt, model, cacheRetention, options.env),
				inferenceConfig: {
					...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
					...(options.temperature !== undefined && { temperature: options.temperature }),
				},
				toolConfig: convertToolConfig(
					getCurrentTools(normalizedContext.messages),
					options.toolChoice,
					supportsStrictMode,
				),
				additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
				...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
			};
			const nextCommandInput = await options?.onPayload?.(commandInput, model);
			if (nextCommandInput !== undefined) {
				commandInput = nextCommandInput as typeof commandInput;
			}
			const command = new ConverseStreamCommand(commandInput);

			const response = await client.send(command, { abortSignal: options.signal });
			responseRequestId = normalizeDiagnosticValue(response.$metadata.requestId);
			if (!observedRawResponse && response.$metadata.httpStatusCode !== undefined) {
				const responseHeaders: Record<string, string> = {};
				if (response.$metadata.requestId) {
					responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
				}
				await options?.onResponse?.({ status: response.$metadata.httpStatusCode, headers: responseHeaders }, model);
			}

			for await (const item of response.stream!) {
				await options.onProviderStreamEvent?.(item, model);
				if (item.messageStart) {
					if (item.messageStart.role !== ConversationRole.ASSISTANT) {
						throw new Error("Unexpected assistant message start but got user message start instead");
					}
					stream.push({ type: "start", partial: output });
				} else if (item.contentBlockStart) {
					handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
				} else if (item.contentBlockDelta) {
					handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
				} else if (item.contentBlockStop) {
					handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
				} else if (item.messageStop) {
					output.rawStopReason = item.messageStop.stopReason;
					const { stopReason, errorMessage } = mapStopReason(item.messageStop.stopReason);
					output.stopReason = stopReason;
					if (errorMessage) {
						output.errorMessage = errorMessage;
					}
				} else if (item.metadata) {
					handleMetadata(item.metadata, model, output);
				} else if (item.internalServerException) {
					throw item.internalServerException;
				} else if (item.modelStreamErrorException) {
					throw item.modelStreamErrorException;
				} else if (item.validationException) {
					throw item.validationException;
				} else if (item.throttlingException) {
					throw item.throttlingException;
				} else if (item.serviceUnavailableException) {
					throw item.serviceUnavailableException;
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Bedrock stream ended without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// 流可能在未停止每个 block 的情况下结束，因此在这里也要做收尾。
			for (const block of output.content) finalizeStreamingBlock(block as Block);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				finalizeStreamingBlock(block as Block);
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatBedrockError(error);
			if (output.stopReason === "error") {
				appendBedrockFailureDiagnostic(output, error, responseRequestId);
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Bedrock SDK 异常名的人类可读前缀。
 * agent-session 中的下游 retry 逻辑匹配 `server.?error`、
 * `service.?unavailable` 等模式，因此沿用旧版前缀格式，
 * 而不是直接使用 SDK 异常名。
 */
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	InternalServerException: "Internal server error",
	ModelStreamErrorException: "Model stream error",
	ValidationException: "Validation error",
	ThrottlingException: "Throttling error",
	ServiceUnavailableException: "Service unavailable",
};

/**
 * 有些模型会拒绝账户/profile 所配置的 Bedrock data retention 模式
 * （如 "data retention mode 'default' is not available for this model"）。
 * 让用户参考 AWS 文档了解如何配置受支持的模式。
 */
const BEDROCK_DATA_RETENTION_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";

/**
 * 为 Bedrock 错误加上人类可读的前缀。
 * AWS SDK 异常（无论是来自 `client.send()` 还是流事件项）都
 * 继承自 BedrockRuntimeServiceException。我们把 `.name` 映射为稳定的
 * 人类可读前缀，便于下游（retry 逻辑、context overflow 检测）
 * 通过简单字符串匹配区分错误类别。
 */
function formatBedrockError(error: unknown): string {
	const norm = normalizeProviderError(error);
	// 当 SDK 未把原始 HTTP body 并入 message 时，直接把 body（连同状态码）呈现出来；
	// 否则退回 message。这样网关 403 才不会塌缩成 `Unknown: UnknownError`。
	const core =
		!norm.messageCarriesBody && norm.status !== undefined && norm.body !== undefined
			? `${norm.status}: ${norm.body}`
			: norm.message;
	const dataRetentionHint = /data retention mode/i.test(core)
		? ` See ${BEDROCK_DATA_RETENTION_DOCS_URL} for supported data retention modes.`
		: "";
	if (error instanceof BedrockRuntimeServiceException) {
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		return `${prefix}: ${core}${dataRetentionHint}`;
	}
	return `${core}${dataRetentionHint}`;
}

type SdkErrorMetadata = { $metadata?: { httpStatusCode?: unknown; requestId?: unknown } };

/** 过长的 header 值直接丢弃而非截断：被截断的 request id 就不再是 request id。 */
const MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS = 200;

function normalizeDiagnosticValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS) return undefined;
	return trimmed;
}

/**
 * 无论是 service exception 还是未建模的流错误，SDK 都把错误码放在 `error.name` 上，
 * 因此不要只收窄到 `BedrockRuntimeServiceException`。Bedrock 已建模的错误名都以
 * `Exception` 结尾，而 `TimeoutError` 之类的传输层错误名则不然。
 */
function extractBedrockErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !error.name.endsWith("Exception")) return undefined;
	return normalizeDiagnosticValue(error.name);
}

/**
 * 附着在 `errorMessage` 旁的结构化元数据；由于 `isRetryableAssistantError`
 * 会对它做匹配，必须保持逐字节一致。未知字段省略、绝不臆测：已建模的中途流异常
 * 以裸对象字面量到达，只留下 `fallbackRequestId`。仅记录 `details`，因为抛出的不一定 `Error`。
 */
function appendBedrockFailureDiagnostic(
	output: AssistantMessage,
	error: unknown,
	fallbackRequestId: string | undefined,
): void {
	const metadata = (error as SdkErrorMetadata)?.$metadata;
	const details: JsonObject = {};

	if (typeof metadata?.httpStatusCode === "number") details.status = metadata.httpStatusCode;

	const errorCode = extractBedrockErrorCode(error);
	if (errorCode !== undefined) details.errorCode = errorCode;

	const requestId = normalizeDiagnosticValue(metadata?.requestId) ?? fallbackRequestId;
	if (requestId !== undefined) details.requestId = requestId;

	if (Object.keys(details).length === 0) return;

	appendAssistantMessageDiagnostic(output, { type: "bedrock_response_failure", timestamp: Date.now(), details });
}

/**
 * 绝不允许被调用方提供的 header 覆盖的键。
 * `host` 与 `x-amz-*` 参与 SigV4 canonical request；`authorization`
 * 归 SigV4 或 bearer-token 路径（config.token + authSchemePreference）所有。
 * 以大小写不敏感方式比较（查找前会先把调用方键名转小写）。
 */
const RESERVED_HEADER_EXACT = new Set(["authorization", "host"]);

function isReservedHeader(key: string): boolean {
	const lower = key.toLowerCase();
	return lower.startsWith("x-amz-") || RESERVED_HEADER_EXACT.has(lower);
}

/**
 * 通过 Smithy `build` 步骤 middleware 把调用方的 header 附加到发往 Bedrock 的请求上。
 * `build` 步骤运行在请求序列化之后、SigV4 签名之前，因此注入的 header 会被覆盖进签名。
 * 保留的 SigV4 / 认证 header（`x-amz-*`、`authorization`、`host`）被静默跳过；
 * 其余调用方 header 均覆盖请求上已有的同名 header。
 */
function addCustomHeadersMiddleware(client: BedrockRuntimeClient, headers: Record<string, string>): void {
	const middleware: BuildMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const request = args.request;
		if (request && typeof request === "object" && "headers" in request) {
			const requestHeaders = (request as { headers: Record<string, string> }).headers;
			for (const [key, value] of Object.entries(headers)) {
				if (!isReservedHeader(key)) {
					requestHeaders[key] = value;
				}
			}
		}
		return next(args);
	};
	client.middlewareStack.add(middleware, { step: "build", name: "pi-ai-custom-headers", priority: "low" });
}

function isSmithyHttpResponse(response: unknown): response is HttpResponse {
	if (!response || typeof response !== "object") return false;
	const candidate = response as Partial<HttpResponse>;
	return typeof candidate.statusCode === "number" && !!candidate.headers && typeof candidate.headers === "object";
}

function toProviderResponse(response: unknown): ProviderResponse | undefined {
	if (!isSmithyHttpResponse(response)) return undefined;
	return { status: response.statusCode, headers: { ...response.headers } };
}

/**
 * Bedrock 已建模的 `$metadata` 只保留部分 HTTP 元数据（例如 requestId），
 * 自定义网关 header 会在调用方看到 `onResponse` 之前丢失。于是在 deserialize
 * 步骤捕获原始 Smithy HTTP 响应——时机在 SDK 收到响应之后、
 * 消费事件流之前。
 */
function addResponseHeadersMiddleware(
	client: BedrockRuntimeClient,
	onResponse: NonNullable<BedrockOptions["onResponse"]>,
	model: Model<"bedrock-converse-stream">,
	onObserved: () => void,
): void {
	const middleware: DeserializeMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const result = await next(args);
		const providerResponse = toProviderResponse(result.response);
		if (providerResponse) {
			onObserved();
			await onResponse(providerResponse, model);
		}
		return result;
	};
	client.middlewareStack.add(middleware, { step: "deserialize", name: "pi-ai-response-headers" });
}

export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies BedrockOptions;
	if (!options?.reasoning) {
		return stream(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	if (isAnthropicClaudeModel(model)) {
		if (supportsAdaptiveThinking(model.id, model.name)) {
			return stream(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			} satisfies BedrockOptions);
		}

		// undefined 表示调用方未要求输出上限；让 helper 使用模型上限。
		// 不要在这里强行折算成 0，否则 thinking 预算会变成整个 maxTokens 值。
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
			reasoning: options.reasoning,
			thinkingBudgets: {
				...(options.thinkingBudgets || {}),
				[clampReasoning(options.reasoning)!]: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
			},
		} satisfies BedrockOptions);
	}

	return stream(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	} satisfies BedrockOptions);
};

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: start.toolUse.toolUseId || "",
			name: start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	let index = blocks.findIndex((b) => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// 若尚无文本 block 则创建一个，因为文本块不会触发 `handleContentBlockStart`
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		block.arguments = parseStreamingJson(block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			// `thinkingSignature` 要么承载 Anthropic 签名，要么承载不透明的 redacted
			// 载荷，绝不能两者都放：混用会破坏先到达的那份。
			if (delta.reasoningContent.signature && !thinkingBlock.redacted) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
			if (delta.reasoningContent.redactedContent?.length) {
				// 非 Anthropic 模型（如 OpenAI GPT-5.6）在 Bedrock 上的加密 reasoning。
				// 载荷不透明，因此按 Anthropic 路径存 redacted thinking 的方式，
				// 原样保留在 `thinkingSignature` 中，下一轮再回放。
				if (!thinkingBlock.redacted) {
					thinkingBlock.redacted = true;
					thinkingBlock.thinkingSignature = "";
					thinkingBlock.thinking += REDACTED_THINKING_PLACEHOLDER;
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingIndex,
						delta: REDACTED_THINKING_PLACEHOLDER,
						partial: output,
					});
				}
				thinkingBlock.redactedChunks ??= [];
				thinkingBlock.redactedChunks.push(delta.reasoningContent.redactedContent);
			}
		}
	}
}

/**
 * 把缓冲的加密 reasoning 编码进 `thinkingSignature` 并丢弃暂存缓冲区。
 * 该缓冲区绝不能进入持久化的消息：`Uint8Array` 会序列化成按索引键的对象，
 * 体积约为 base64 载荷的十倍。
 */
function flushRedactedContent(block: Block): void {
	if (block.type !== "thinking" || !block.redactedChunks) return;
	block.thinkingSignature = bytesToBase64(block.redactedChunks);
	delete block.redactedChunks;
}

/**
 * 清除所有流式暂存字段。终端路径与 `contentBlockStop` 都要执行，
 * 因为流可能在没有逐块停止的情况下结束。
 */
function finalizeStreamingBlock(block: Block): void {
	delete block.index;
	// partialJson 只是流式暂存缓冲；绝不持久化。
	delete block.partialJson;
	flushRedactedContent(block);
}

function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.cacheWrite1h = event.usage.cacheDetails?.reduce(
			(total, detail) => total + (detail.ttl === CacheTTL.ONE_HOUR ? (detail.inputTokens ?? 0) : 0),
			0,
		);
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	delete (block as Block).index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			flushRedactedContent(block);
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson);
			// 原地收尾并剥离暂存缓冲，确保回放只携带解析后的参数。
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * 检查模型是否支持 adaptive thinking（Opus 4.6+、Sonnet 4.6）。
 * 同时检查 model ID 和 model name，以支持 ARN 中不含模型名的
 * application inference profile。
 */
function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
	const candidates = getModelMatchCandidates(modelId, modelName);
	return candidates.some(
		(s) =>
			s.includes("opus-4-6") ||
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-4-6") ||
			s.includes("sonnet-5") ||
			s.includes("haiku-5") ||
			s.includes("fable-5"),
	);
}

function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some(
		(s) =>
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-5") ||
			s.includes("haiku-5") ||
			s.includes("fable-5"),
	);
}

/**
 * 检查模型是否接受 `thinking.block_binding`。Opus 4.6 与 Sonnet 4.6 会报错
 * "thinking.adaptive.block_binding: Extra inputs are not permitted"。
 */
function supportsThinkingBlockBinding(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some(
		(s) =>
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-5") ||
			s.includes("haiku-5") ||
			s.includes("fable-5"),
	);
}

function mapThinkingLevelToEffort(
	model: Model<"bedrock-converse-stream">,
	level: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" | "xhigh" | "max" {
	if (level === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";

	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as "low" | "medium" | "high" | "xhigh" | "max";

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

/**
 * 检查模型是否为 Bedrock 上的 Anthropic Claude 模型。
 * 同时检查 model ID 和 model name，以支持 ARN 中不含模型名的
 * application inference profile。
 */
function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name?.toLowerCase() ?? "";
	return (
		id.includes("anthropic.claude") ||
		id.includes("anthropic/claude") ||
		name.includes("anthropic.claude") ||
		name.includes("anthropic/claude") ||
		name.includes("claude")
	);
}

/**
 * 检查模型是否支持 prompt caching。
 * 支持：Claude 3.5 Haiku、Claude 3.7 Sonnet、Claude 4.x 系列、Claude 5 系列
 *
 * 对 base 模型和 system 定义的 inference profile，模型 ID / ARN 中
 * 含有模型名，可以本地判断。
 *
 * 对 application inference profile（其 ARN 不含模型名），
 * 还会检查 model.name——用户可通过 models.json 或 registerProvider 设置。
 * 实在不行，可设置 AWS_BEDROCK_FORCE_CACHE=1 强制启用 cache point。
 * Amazon Nova 模型自带自动缓存，无需显式 cache point。
 */
function supportsPromptCaching(model: Model<"bedrock-converse-stream">, env?: ProviderEnv): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);

	const hasClaudeRef = candidates.some((s) => s.includes("claude"));
	if (!hasClaudeRef) {
		// application inference profile 的 ARN 不含模型名。
		// 允许用户通过环境变量强制启用 cache point。
		if (getProviderEnvValue("AWS_BEDROCK_FORCE_CACHE", env) === "1") return true;
		return false;
	}
	// Claude 5 系列（fable-5、opus-5、sonnet-5、haiku-5）
	if (
		candidates.some(
			(s) => s.includes("fable-5") || s.includes("opus-5") || s.includes("sonnet-5") || s.includes("haiku-5"),
		)
	)
		return true;
	// Claude 4.x 系列（opus-4、sonnet-4、haiku-4）
	if (candidates.some((s) => s.includes("-4-"))) return true;
	// Claude 3.7 Sonnet
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	// Claude 3.5 Haiku
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;
	return false;
}

/**
 * 检查模型是否支持 reasoningContent 中的 thinking 签名。
 * 只有 Anthropic Claude 模型支持 signature 字段。
 * 其他模型（OpenAI、Qwen、Minimax、Moonshot 等）会报错：
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * 同时检查 model ID 和 model name，以支持 application inference profile。
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	return isAnthropicClaudeModel(model);
}

function buildSystemPrompt(
	systemPrompt: string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env?: ProviderEnv,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

	// 为受支持的 Claude 模型在启用缓存时添加 cache point
	if (cacheRetention !== "none" && supportsPromptCaching(model, env)) {
		blocks.push({
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	return blocks;
}

function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function createNonBlankTextBlock(text: string): ContentBlock.TextMember | undefined {
	const sanitized = sanitizeSurrogates(text);
	return sanitized.trim().length === 0 ? undefined : { text: sanitized };
}

function createRequiredTextBlock(text: string): ContentBlock.TextMember {
	return createNonBlankTextBlock(text) ?? { text: EMPTY_TEXT_PLACEHOLDER };
}

function sanitizeBedrockDocument(value: JsonValue): DocumentType {
	if (Array.isArray(value)) {
		return value.map(sanitizeBedrockDocument);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key.length > 0)
				.map(([key, nestedValue]) => [key, sanitizeBedrockDocument(nestedValue)]),
		);
	}
	return value;
}

function convertToolResultContent(content: (TextContent | ImageContent)[]): ToolResultContentBlock[] {
	const result: ToolResultContentBlock[] = [];
	for (const c of content) {
		if (c.type === "image") {
			result.push({ image: createImageBlock(c.mimeType, c.data) });
		} else {
			const textBlock = createNonBlankTextBlock(c.text);
			if (textBlock) result.push(textBlock);
		}
	}
	if (result.length === 0) result.push({ text: EMPTY_TEXT_PLACEHOLDER });
	return result;
}

function convertMessages(
	context: TranscriptContext,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env?: ProviderEnv,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(
		withoutInitialSystemMessage(context.messages),
		model,
		normalizeToolCallId,
	);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "user": {
				const content: ContentBlock[] = [];
				if (typeof m.content === "string") {
					content.push(createRequiredTextBlock(m.content));
				} else {
					for (const c of m.content) {
						switch (c.type) {
							case "text": {
								const textBlock = createNonBlankTextBlock(c.text);
								if (textBlock) content.push(textBlock);
								break;
							}
							case "image":
								content.push({ image: createImageBlock(c.mimeType, c.data) });
								break;
							default:
								continue;
						}
					}
					if (content.length === 0) content.push({ text: EMPTY_TEXT_PLACEHOLDER });
				}
				result.push({ role: ConversationRole.USER, content });
				break;
			}
			case "assistant": {
				// 跳过内容为空的 assistant 消息（例如来自被中止的请求）
				// Bedrock 会拒绝 content 数组为空的消息
				if (m.content.length === 0) {
					continue;
				}
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text": {
							// 跳过空的文本块
							const textBlock = createNonBlankTextBlock(c.text);
							if (!textBlock) continue;
							contentBlocks.push(textBlock);
							break;
						}
						case "toolCall":
							contentBlocks.push({
								toolUse: { toolUseId: c.id, name: c.name, input: sanitizeBedrockDocument(c.arguments) },
							});
							break;
						case "thinking": {
							// 加密 reasoning 不透明：把存储的载荷作为 `redactedContent` 成员
							// 回放，而不是降级成普通 reasoning 文本。
							if (c.redacted) {
								const redactedContent = decodeRedactedContent(c.thinkingSignature);
								if (redactedContent?.length) {
									contentBlocks.push({ reasoningContent: { redactedContent } });
								}
								continue;
							}
							// 跳过空的 thinking 块
							const thinking = sanitizeSurrogates(c.thinking);
							if (thinking.trim().length === 0) continue;
							// 只有 Anthropic 模型支持 reasoningText 里的 signature 字段。
							// 其他模型会省略签名以避免类似下面的错误：
							// "This model doesn't support the reasoningContent.reasoningText.signature field"
							if (supportsThinkingSignature(model)) {
								// 签名在 thinking 增量之后到达。部分消息或外部持久化的消息
								// 可能缺少签名，此时 Bedrock 会拒绝回放的 reasoning 块。
								// 与 Anthropic 一致，退回纯文本。
								if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
									contentBlocks.push({ text: thinking });
								} else {
									contentBlocks.push({
										reasoningContent: {
											reasoningText: {
												text: thinking,
												signature: c.thinkingSignature,
											},
										},
									});
								}
							} else {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: thinking },
									},
								});
							}
							break;
						}
						default:
							continue;
					}
				}
				// 若全部 content 块都被过滤掉则跳过
				if (contentBlocks.length === 0) {
					continue;
				}
				result.push({
					role: ConversationRole.ASSISTANT,
					content: contentBlocks,
				});
				break;
			}
			case "toolResult": {
				// 把所有连续的 toolResult 消息合并进一条 user 消息
				// Bedrock 要求所有 tool result 位于同一条消息中
				const toolResults: ContentBlock.ToolResultMember[] = [];

				// 连同全部 content 块一起添加当前 tool result
				toolResults.push({
					toolResult: {
						toolUseId: m.toolCallId,
						content: convertToolResultContent(m.content),
						status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
					},
				});

				// 向后查找连续的 toolResult 消息
				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: nextMsg.toolCallId,
							content: convertToolResultContent(nextMsg.content),
							status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					j++;
				}

				// 跳过已处理过的消息
				i = j - 1;

				result.push({ role: ConversationRole.USER, content: toolResults });
				break;
			}
			default:
				continue;
		}
	}

	// 为受支持的 Claude 模型在启用缓存时向最后一条 user 消息添加 cache point
	if (cacheRetention !== "none" && supportsPromptCaching(model, env) && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			(lastMessage.content as ContentBlock[]).push({
				cachePoint: {
					type: CachePointType.DEFAULT,
					...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
				},
			});
		}
	}

	return result;
}

function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
	supportsStrictMode: boolean,
): ToolConfiguration | undefined {
	if (!tools?.length) return undefined;
	if (toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map((tool) => {
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		return {
			toolSpec: {
				name: tool.name,
				description: tool.description,
				inputSchema: { json: getJsonSchemaToolParameters(tool, strict) as unknown as DocumentType },
				...(strict === true ? { strict: true } : {}),
			},
		};
	});

	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function mapStopReason(reason: string | undefined): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return { stopReason: "stop" };
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return { stopReason: "length" };
		case BedrockStopReason.TOOL_USE:
			return { stopReason: "toolUse" };
		default:
			return reason
				? { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` }
				: { stopReason: "error" };
	}
}

function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	return (
		options.region ||
		getProviderEnvValue("AWS_REGION", options.env) ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options.env) ||
		undefined
	);
}

function getConfiguredBedrockCredentials(env?: ProviderEnv): BedrockRuntimeClientConfig["credentials"] | undefined {
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);
	if (!accessKeyId || !secretAccessKey) {
		return undefined;
	}
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", env);
	return {
		accessKeyId,
		secretAccessKey,
		...(sessionToken ? { sessionToken } : {}),
	};
}

function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}

	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname.toLowerCase().match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function shouldUseExplicitBedrockEndpoint(
	baseUrl: string,
	configuredRegion: string | undefined,
	hasAmbientConfiguredProfile: boolean,
): boolean {
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	if (!endpointRegion) {
		return true;
	}

	return !configuredRegion && !hasAmbientConfiguredProfile;
}

function isGovCloudBedrockTarget(model: Model<"bedrock-converse-stream">, options: BedrockOptions): boolean {
	const region = getConfiguredBedrockRegion(options);
	if (region?.toLowerCase().startsWith("us-gov-")) {
		return true;
	}

	const modelId = model.id.toLowerCase();
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, any> | undefined {
	if (!options.reasoning || !model.reasoning) {
		return undefined;
	}

	if (isAnthropicClaudeModel(model)) {
		// GovCloud Bedrock 目前会拒绝 Claude 的 thinking.display 字段。
		// 在 GovCloud Converse schema 跟进之前先省略它。
		const isGovCloud = isGovCloudBedrockTarget(model, options);
		const display = isGovCloud ? undefined : (options.thinkingDisplay ?? "summarized");
		// 回放带签名的 thinking 块与其创建时的 system prompt 及 tools 绑定。
		// 任一发生变化后，若不丢弃过期块，Bedrock 会对回放请求返回 400，
		// 与 Anthropic provider 保持一致。在 GovCloud 上同 display 一样跳过。
		const useBlockBinding = !isGovCloud && supportsThinkingBlockBinding(model);
		const result: Record<string, any> = supportsAdaptiveThinking(model.id, model.name)
			? {
					thinking: {
						type: "adaptive",
						...(display !== undefined ? { display } : {}),
						...(useBlockBinding ? { block_binding: { prefix_mismatch_behavior: "drop_block" } } : {}),
					},
					output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
					...(useBlockBinding ? { anthropic_beta: [THINKING_BINDING_CONTROLS_BETA] } : {}),
				}
			: (() => {
					const defaultBudgets: Record<ThinkingLevel, number> = {
						minimal: 1024,
						low: 2048,
						medium: 8192,
						high: 16384,
						xhigh: 16384, // 基于预算的 Claude 会把扩展档位钳制到 high
						max: 16384,
					};

					// 自定义预算只覆盖到 high 为止的基于 token 的档位。
					const level = options.reasoning === "xhigh" || options.reasoning === "max" ? "high" : options.reasoning;
					const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

					return {
						thinking: {
							type: "enabled",
							budget_tokens: budget,
							...(display !== undefined ? { display } : {}),
						},
					};
				})();

		if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
			result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		}

		return result;
	}

	const candidates = getModelMatchCandidates(model.id, model.name);

	if (candidates.some((s) => s.includes("gpt-oss"))) {
		return { reasoning_effort: OPENAI_GPT_OSS_EFFORT[options.reasoning] };
	}

	if (candidates.some((s) => s.includes("gpt-"))) {
		const mapped = model.thinkingLevelMap?.[options.reasoning];
		return {
			reasoning: { effort: typeof mapped === "string" ? mapped : OPENAI_GPT_EFFORT[options.reasoning] },
		};
	}

	return undefined;
}

type OpenAIGptEffort = "low" | "medium" | "high" | "xhigh" | "max";
type OpenAIGptOssEffort = "low" | "medium" | "high";

/** OpenAI GPT 模型（GPT-5.x、GPT-6）接受嵌套的 `reasoning.effort`，且拒绝 `minimal`。 */
const OPENAI_GPT_EFFORT: Record<ThinkingLevel, OpenAIGptEffort> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** gpt-oss 接受扁平的 `reasoning_effort`，且只接受 low、medium、high。 */
const OPENAI_GPT_OSS_EFFORT: Record<ThinkingLevel, OpenAIGptOssEffort> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
};

function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	return { source: { bytes: base64ToBytes(data) }, format };
}

function base64ToBytes(data: string): Uint8Array {
	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

/**
 * 解码存储的 redacted 载荷。AWS SDK 以字节形式交付该 blob，但
 * 持久化的 session 里保存的是 base64。手工编辑或外部生成的 session
 * 可能保存了非 base64 的签名；此时丢弃该块而不是让整个请求失败。
 */
function decodeRedactedContent(signature: string | undefined): Uint8Array | undefined {
	if (!signature) return undefined;
	try {
		return base64ToBytes(signature);
	} catch {
		return undefined;
	}
}

function bytesToBase64(chunks: Uint8Array[]): string {
	// 加密 reasoning 可达数十 KB，因此以切片方式构建二进制字符串，
	// 而不是每个字节做一次拼接。窗口大小保持在引擎对 spread 调用的
	// 参数数量上限之内。
	const WINDOW = 0x8000;
	let binary = "";
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i += WINDOW) {
			binary += String.fromCharCode(...chunk.subarray(i, i + WINDOW));
		}
	}
	return btoa(binary);
}
