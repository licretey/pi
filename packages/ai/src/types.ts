import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { PiMessagesOptions } from "./api/pi-messages.ts";
import type {
	AnthropicMessagesCompat,
	BedrockCompat,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "./providers/compat-schema.ts";
import type {
	CacheRetention,
	ModelCost,
	ModelInputLimits,
	ModelInputModality,
	ModelPromptCache,
	ModelThinkingLevel,
	ThinkingLevel,
	ThinkingLevelMap,
} from "./providers/model-schema.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type {
	AnthropicAllowedFallbackModel,
	AnthropicMessagesCompat,
	BedrockCompat,
	ChatTemplateKwargValue,
	MistralConversationsCompat,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	OpenRouterRouting,
	SessionAffinityFormat,
	ThinkingTokenBudgetField,
	VercelGatewayRouting,
} from "./providers/compat-schema.ts";
export type {
	CacheRetention,
	ModelCost,
	ModelCostRates,
	ModelCostTier,
	ModelImageInputLimits,
	ModelImageResizeOptions,
	ModelInputLimits,
	ModelInputModality,
	ModelPromptCache,
	ModelThinkingLevel,
	ThinkingLevel,
	ThinkingLevelMap,
} from "./providers/model-schema.ts";
export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

export type Api = KnownApi | (string & {});

export type KnownImageApi = "openrouter-images";

export type ImageApi = KnownImageApi | (string & {});

export type KnownClassifierApi =
	| "typesafe-system-one"
	| "cloudflare-workers-ai-system-one"
	| "llama-cpp-classify"
	| "openai-decisions";

export type ClassifierApi = KnownClassifierApi | (string & {});

export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure"
	| "openai-codex"
	| "radius"
	| "typesafe"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "baseten"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "meta"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "qwen-token-plan-individual"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
export type ProviderId = KnownProvider | string;

export type ToolChoice = "auto" | "none";
export type SamplingParams = Record<string, unknown>;
export type SamplingParamsByThinkingLevel = Partial<Record<ModelThinkingLevel, SamplingParams>>;
/** 每个思考级别的 token 预算（仅限基于 token 计费的 provider） */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// 所有 provider 共享的基础选项
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** provider 范围的环境变量覆盖。取值优先于 process.env。 */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type FetchFunction = typeof globalThis.fetch;

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

/** provider 请求共享的认证、HTTP 传输与生命周期回调。 */
export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	/** 本次逻辑请求产生的遥测的显式父上下文。 */
	telemetryContext?: TelemetryContext;
	apiKey?: string;
	/**
	 * 用于 provider HTTP 请求的可选 fetch 实现。
	 * 默认为 `globalThis.fetch`。无法注入自定义实现的 provider 适配器可以拒绝它。
	 * 不影响 WebSocket 传输。
	 */
	fetch?: FetchFunction;
	/**
	 * provider 范围的环境变量值。对于区域设置、端点占位符、代理变量等
	 * provider 配置，这些值优先于 process.env。
	 */
	env?: ProviderEnv;
	/**
	 * 可选回调，在发送前检查或替换 provider 载荷。
	 * 返回 undefined 表示保持载荷不变。
	 */
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * 可选回调，在收到 HTTP 响应之后调用。
	 */
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	/**
	 * 可选的自定义 HTTP 请求头，会包含进 API 请求。
	 * 与 provider 默认值合并；调用方的值覆盖默认请求头。
	 * 在 AWS Bedrock 上，这些头经由 Smithy `build` 步骤中间件注入，因此
	 * 被 SigV4 签名覆盖；保留头（`x-amz-*`、`authorization`、`host`）会被
	 * 静默忽略，以保全 SigV4 / bearer 认证。
	 * null 值会抑制 provider/API 中同名的默认头。
	 */
	headers?: ProviderHeaders;
	/**
	 * 支持它的 provider/SDK 的 HTTP 请求超时（毫秒）。
	 * 例如 OpenAI 与 Anthropic SDK 客户端默认为 10 分钟。
	 */
	timeoutMs?: number;
	/**
	 * 支持客户端重试的 provider/SDK 的最大重试次数。
	 * 例如 OpenAI 与 Anthropic SDK 客户端默认为 2。
	 */
	maxRetries?: number;
	/**
	 * 当服务器要求较长等待时，重试等待的最大延迟（毫秒）。
	 * 如果服务器要求的延迟超过该值，请求会立即失败并携带其要求的延迟，
	 * 交给上层重试逻辑可见地处理。
	 * 默认：60000（60 秒）。设为 0 表示不设上限。
	 */
	maxRetryDelayMs?: number;
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * 可选回调，在收到 HTTP 响应之后、消费其响应体流之前调用。
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * 可选观察器，观察 Pi 规范化之前每个已解析的 provider 流事件。
	 * 事件数据由适配器持有，必须视为只读。
	 * 适配器支持与否是显式声明的；不支持的适配器不会调用它。
	 */
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	/**
	 * 任意采样参数，按原样合并进请求体，位于各命名请求字段之后，
	 * 因此这里的键会覆盖它们。让自定义的 OpenAI 兼容服务器（llama.cpp、
	 * vLLM、SGLang 等）能收到 pi 未建模的参数，例如 `top_p`、`top_k`、
	 * `min_p`、`repetition_penalty`。逐键合并在 `Model.samplingParams`
	 * 之上。仅被 OpenAI 兼容适配器（completions、responses、Azure
	 * responses）应用；其他 API 忽略它。
	 */
	samplingParams?: SamplingParams;
	maxTokens?: number;
	/**
	 * 支持多种传输方式的 provider 的首选传输方式。
	 * 不支持该选项的 provider 会忽略它。
	 */
	transport?: Transport;
	/**
	 * 提示词缓存的保留期偏好。provider 会将其映射到自己支持的取值。
	 * 默认："short"。
	 */
	cacheRetention?: CacheRetention;
	/**
	 * 可选的会话标识符，用于支持基于会话缓存的 provider。
	 * provider 可用它启用提示词缓存、请求路由或其他会话感知特性。
	 * 不支持的 provider 会忽略它。
	 */
	sessionId?: string;
	/**
	 * 支持 WebSocket 传输的 provider 的 WebSocket 连接超时（毫秒）。
	 * 只覆盖连接/打开握手；连接建立后的流空闲超时使用 timeoutMs。
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * 可选的元数据，会包含进 API 请求。
	 * provider 提取自己认识的字段，忽略其余。
	 * 例如 Anthropic 用 `user_id` 做滥用追踪和限流。
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * provider 长轮询的最大时长（毫秒）。
	 * 默认为 0，即执行一次状态检查。
	 */
	wait?: number;
}

/** 用于尽力而为的延迟响应取消的请求选项。 */
export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>;

/**
 * 把已知 API 映射到其完整的 provider 专属流选项类型。
 * 从 API 实现模块导入的纯类型会在产出时被擦除，因此这是 tree-shake 安全的。
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
	"pi-messages": PiMessagesOptions;
}

/**
 * 某个 API 的完整流选项。已知 API 解析为其具体的选项类型；
 * 自定义 API 字符串回退到通用形态。
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * API 实现模块的统一流契约：`src/api/` 下的每个模块都导出 `stream` 与
 * `streamSimple`；有能力的模块还可以导出延迟响应方法。惰性包装器
 * （`lazyApi()`）和 provider 工厂把它们作为值传递。这是无类型的分发
 * 形态；每个 API 的选项类型定义在实现模块本身以及 `Provider.stream()`
 * 的 `ApiStreamOptions` 上。
 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
}

/**
 * 图像生成 API 实现模块的统一契约：`src/api/` 下的每个图像 API 模块
 * 都只导出 `generateImages`，因此模块本身即满足此接口。惰性包装器和
 * `createProvider({ images })` 把它们作为值传递。
 */
export interface ProviderImages {
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/** 分类器 API 模块实现的统一契约。 */
export interface ProviderClassifier {
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ClassifierOptions,
	): Promise<ClassifierResult>;
}

export interface ClassifierOptions extends ProviderRequestOptions<ClassifierModel<ClassifierApi>> {
	/**
	 * 在把答案 logits 归一化为概率之前，先除以该值。
	 * 大于 1 使分布更平缓；小于 1 使分布更尖锐。必须为正数。
	 * 无法应用它的 API 会忽略它。
	 */
	temperature?: number;
}

export interface ImagesOptions extends ProviderRequestOptions<ImageModel<ImageApi>> {
	/**
	 * 可选的元数据，会包含进 API 请求。
	 * provider 提取自己认识的字段，忽略其余。
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// 传给 streamSimple() 和 completeSimple() 的带推理的统一选项
export interface SimpleStreamOptions extends StreamOptions {
	/** 简单请求的中立的工具选择。省略时适配器采用各自 provider 专属的行为。 */
	toolChoice?: ToolChoice;
	reasoning?: ThinkingLevel;
	/** 要求有能力的 provider 返回持久句柄并异步继续该请求。 */
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	/** 思考级别的自定义 token 预算（仅限基于 token 计费的 provider） */
	thinkingBudgets?: ThinkingBudgets;
}

// 带类型选项的通用 StreamFunction。
//
// 契约：
// - 接收规范化后的转录：系统提示词与工具位于开头的 system 消息中，
//   绝不放在 context 本身上。
// - 必须返回 AssistantMessageEventStream。
// - 直接调用 streamSimple() 时，请求认证缺失可以同步抛出异常。一旦
//   返回了流，请求/模型/运行时失败都应编码在该流中。
// - 错误终止必须产生一个带 stopReason "error" 或 "aborted" 以及
//   errorMessage 的 AssistantMessage，并通过流协议发出。
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: TranscriptContext,
	options?: TOptions,
) => AssistantMessageEventStream;

export type ImagesFunction<TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

export type ClassifierFunction<TOptions extends ClassifierOptions = ClassifierOptions> = (
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options?: TOptions,
) => Promise<ClassifierResult>;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // 例如 OpenAI responses 中的消息元数据（旧版 id 字符串或 TextSignatureV1 JSON）
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // provider 专属的不透明或序列化的推理回放数据
	/** 为 true 时,思考内容已被安全过滤器删减。不透明的加密载荷存储在
	 *  `thinkingSignature` 中，以便回传给 API 实现多轮连续性。 */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 编码的图像数据
	mimeType: string; // 例如 "image/jpeg"、"image/png"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string; // Google 专属：复用思考上下文的不透明签名
	/** OpenAI Responses 的命名空间，用于调用动态加载或带命名空间的工具。 */
	namespace?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** `cacheWrite` 中按 1 小时保留期写入的部分。只有 Anthropic 报告这一拆分。 */
	cacheWrite1h?: number;
	/**
	 * 推理/思考 token，当 provider 有报告时。这是 `output` 的子集：
	 * `output` 已包含这些 token。暴露推理明细的 provider 会设为一个数字
	 * （可以为 0）；不暴露的 provider 留为 undefined。
	 */
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue] ? ([JsonValue] extends [T] ? true : false) : false;
type IsJsonProperty<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: [Exclude<T, undefined>] extends [never]
			? true
			: IsJsonCompatible<Exclude<T, undefined>>;
type InvalidJsonKeys<T extends object> = {
	[TKey in keyof T]-?: TKey extends string | number ? (IsJsonProperty<T[TKey]> extends true ? never : TKey) : TKey;
}[keyof T];
type IsJsonCompatible<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: IsExactlyJsonValue<T> extends true
			? true
			: T extends null | boolean | number | string
				? true
				: T extends undefined
					? false
					: T extends readonly (infer TItem)[]
						? IsJsonCompatible<TItem>
						: T extends (...args: never[]) => unknown
							? false
							: T extends object
								? [InvalidJsonKeys<T>] extends [never]
									? true
									: false
								: false;

/** 带类型的内存值的 JSON 表示。对象的可选属性保持可选。 */
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: [T] extends [JsonValue]
			? T
			: T extends readonly unknown[]
				? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
					: never;

export interface DeferredHandle {
	provider: string;
	modelId: string;
	api: string;
	/** provider 的 token，例如响应 id，或批量 id 加行 id。 */
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	/** 重建最终 assistant 消息所需的 provider 转换数据。 */
	data?: JsonValue;
}

/**
 * 转录中某一时点的系统指令与工具声明。
 *
 * 开头的 system 消息即系统提示词。后续的 system 消息会修改它：
 * `content` 从该时点起追加指令，`sections` 按名称替换或移除提示词
 * 分节，`toolsAdded`/`toolsRemoved` 变更工具集。按顺序重放每条
 * system 消息即得到当前的提示词与工具。接受会话中途插入 system
 * 消息的 provider 会原位发送每一条；其他 provider 则根据重放出的
 * 状态重建开头的 system 消息。
 */
export interface SystemMessage {
	role: "system";
	/** 指令文本。在开头消息上这是基础提示词；之后则是追加的指令。 */
	content: string | TextContent[];
	/**
	 * 有名字、有顺序的提示词分节，在 `content` 之后按原样渲染。开头消息
	 * 声明它们；后续消息按名称替换分节，`null` 表示移除。请让每个分节
	 * 自带定界（如一个标签、一个标题），这样模型才能把更新与原文对应
	 * 起来。避免形如整数的名字；JSON 对象会重排它们。
	 */
	sections?: Record<string, string | null>;
	/** 从此时点起可用的工具的完整定义。 */
	toolsAdded?: Tool[];
	/** 从此时点起不再可用的工具。 */
	toolsRemoved?: ToolReference[];
	timestamp: number; // Unix 时间戳（毫秒）
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix 时间戳（毫秒）
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string; // provider 报告的具体模型，与请求的 `model` 不同时
	responseId?: string; // 上游 API 暴露时的 provider 专属响应/消息标识符
	/** 本次响应使用的精确的 provider 原生努力级别。旧版或非托管响应中不存在。 */
	providerThinkingLevel?: string;
	/** agent 循环为本次响应请求的 Pi 思考级别。agent 循环之外及旧版响应中不存在。 */
	thinkingLevel?: ModelThinkingLevel;
	diagnostics?: AssistantMessageDiagnostic[]; // 失败与恢复时已脱敏的 provider/运行时诊断信息。
	usage: Usage;
	stopReason: StopReason;
	deferred?: DeferredHandle;
	errorMessage?: string;
	rawStopReason?: string;
	/**
	 * provider 给出的、模型是否显式结束本轮的指示。
	 * 仅为调试保留，目前不影响 agent 控制流。
	 */
	endTurn?: boolean;
	/** 请求开始时的 Unix 时间戳（毫秒）。 */
	timestamp: number;
	/**
	 * 从 `timestamp` 到响应结束的毫秒数，用单调时钟测量。由
	 * `AssistantMessageEventStream` 在其见证过开始的那次响应的最后一条
	 * 消息上设置；旧版消息以及之后才取回的延迟结果中没有。
	 */
	durationMs?: number;
}

/** 另一个工具在运行期间发起的工具调用，例如来自 codemode 脚本。 */
export interface NestedToolCallRecord {
	id: string;
	name: string;
	/** 超出大小限制时省略；此时 `argumentsBytes` 给出其大小。 */
	arguments?: JsonObject;
	/** 参数按 JSON 计的 UTF-8 大小，在 `arguments` 被省略时设置。 */
	argumentsBytes?: number;
	/** `unfinished`：调用方工具结束时该调用仍在运行。 */
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	/** 错误文本，已截断。 */
	error?: string;
}

/** 工具发起的嵌套调用的有界记录。结果不会记录。 */
export interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	/** 有调用被丢弃、参数被省略或调用未完成时为 false。 */
	complete: boolean;
}

export type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true
	? {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextContent | ImageContent)[]; // 支持文本与图像
			details?: JsonRepresentation<TDetails>;
			/** 工具执行本身的用量（如果有）。不计入主 LLM 上下文账目。 */
			usage?: Usage;
			/** 此工具对其他工具发起的调用。仅为会话记录保留；不会发给模型。 */
			nestedCalls?: NestedToolCalls;
			isError: boolean;
			/** 结果创建时的 Unix 时间戳（毫秒）。 */
			timestamp: number;
			/** 工具执行的毫秒数，用单调时钟测量。旧版结果中不存在。 */
			durationMs?: number;
		}
	: never;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;

export interface ImagesContext {
	input: ImagesInputContent[];
}

export type ImagesStopReason = "stop" | "error" | "aborted";

export interface AssistantImages {
	api: ImageApi;
	provider: ProviderId;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number; // Unix 时间戳（毫秒）
}

export interface ClassifierChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface ClassifierScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}

export interface ClassifierBoolQuestion {
	type: "bool";
	instructions: string;
	criteria: { true: string; false: string };
}

export type ClassifierQuestion = ClassifierChoiceQuestion | ClassifierScoreQuestion | ClassifierBoolQuestion;

export interface ClassifierContext {
	state: JsonObject;
	/**
	 * 与 `state` 一起判定的图像。只有 `input` 包含 `"image"` 的模型接受
	 * 它们；其他模型返回错误结果。
	 */
	images?: ImageContent[];
	questions: Record<string, ClassifierQuestion>;
}

export interface ClassifierChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ClassifierScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
}

export interface ClassifierBoolAnswer {
	type: "bool";
	probability: number;
}

export type ClassifierAnswer = ClassifierChoiceAnswer | ClassifierScoreAnswer | ClassifierBoolAnswer;
export type ClassifierStopReason = "stop" | "error" | "aborted";

export interface ClassifierResult {
	api: ClassifierApi;
	provider: ProviderId;
	model: string;
	answers: Record<string, ClassifierAnswer>;
	/** 当服务报告 token 计数时，token 用量及其按模型目录价格的费用。 */
	usage?: Usage;
	stopReason: ClassifierStopReason;
	errorMessage?: string;
	timestamp: number; // Unix 时间戳（毫秒）
}

import type { TSchema } from "typebox";

/** 用于受限采样的 OpenAI 语法变体。 */
export type GrammarFormat = "openai_lark" | "openai_regex";

export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

/**
 * 工具的可选 provider 侧受限采样配置。
 *
 * `json_schema` 取值大致对应各 API 中 `strict` 的概念，由 API 以
 * json-schema 受限采样实现。语法变体让调用方能提供同一目标语言的
 * provider 专属编码。
 */
export type ConstrainedSamplingConfig =
	| {
			type: "json_schema";
			strict: "prefer" | "require";
	  }
	| {
			type: "grammar";
			variants: GrammarVariants;
	  };

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

export interface ToolReference {
	name: string;
}

/**
 * 公开流式入口（`Models.stream()`、`streamSimple()` 等）接受的请求输入。
 * `systemPrompt` 和 `tools` 是开头 system 消息的简写形式；
 * `normalizeContext()` 会在请求抵达 provider 之前把它们折叠为一条。
 */
export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

declare const transcriptContextBrand: unique symbol;

/**
 * 传给 provider 和 API 实现的规范化请求上下文。提示词与工具声明由
 * 转录中的 system 消息承载。只有 `normalizeContext()` 能产出该类型，
 * 因此原始 `Context` 不可能意外流入 provider 代码。
 */
export type TranscriptContext = {
	messages: Message[];
	readonly [transcriptContextBrand]: true;
};

/**
 * AssistantMessageEventStream 的事件协议。
 *
 * 成功的流会先发出 `start` 再发出部分更新，并以 `done` 终止。当请求
 * 准备在生成开始前失败时，流可以直接以 `error` 终止；`start` 之后的
 * 失败同样以 `error` 终止。直接调用 `streamSimple()` 时，请求认证缺失
 * 会同步抛出异常。更新与 `done` 绝不能出现在 `start` 之前。
 *
 * `partial` 是共享的"目前响应"实时助手对象，不是事件发生时的快照。
 * 文本与思考块在其 `*_start` 事件发出时为空，只通过对应的 `*_delta`
 * 事件增长，直到权威的 `*_end`。被删减的思考可能在开始时就已完整，
 * 从而不发出增量。`toolcall_start` 时的工具调用参数取决于 provider；
 * `toolcall_delta` 携带后续的 JSON 更新。
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/** 每个目录条目共有的字段，与你能用它做什么无关。 */
export interface BaseModel<TApi extends string> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	input: ModelInputModality[];
	/** provider 的输入限制与缓存安全预处理元数据。 */
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
}

/** 聊天模型：可用于 `stream()` 及其同类方法。 */
export interface Model<TApi extends Api> extends BaseModel<TApi> {
	/**
	 * 可选：chat 是默认的模型类型，因此没有 `type` 的模型就是聊天模型。
	 * 收窄混合模型列表时请用 `isModelType()`，不要直接比较 `type`。
	 */
	type?: "chat";
	reasoning: boolean;
	/**
	 * 把 pi 思考级别映射为 provider/模型专属取值。
	 * 缺失的键使用 provider 默认值。null 标记该级别不受支持。
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** 每个保留层级的提示词缓存寿命。provider 缓存行为未知时不设置。 */
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	/** 该模型的默认采样参数。见 {@link StreamOptions.samplingParams}；逐请求的键会覆盖它们。 */
	samplingParams?: SamplingParams;
	/** 由实际生效的 pi 思考级别选定的采样参数覆盖。 */
	samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
	/** OpenAI 兼容 API 的兼容性覆盖。未设置时从 baseUrl 自动探测。 */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: TApi extends "mistral-conversations"
						? MistralConversationsCompat
						: never;
}

/** 图像生成模型：只能用于 `generateImages()`。 */
export interface ImageModel<TApi extends ImageApi> extends BaseModel<TApi> {
	type: "image";
	/** 输出模态。始终包含 `"image"`；`"text"` 表示模型也能返回文本块。 */
	output: ("text" | "image")[];
}

/** 结构化分类器模型：只能用于 `classify()`。 */
export interface ClassifierModel<TApi extends ClassifierApi> extends BaseModel<TApi> {
	type: "classifier";
	contextWindow: number;
}

/** 每种模型类型对应的模型形态。 */
export interface ModelTypeMap {
	chat: Model<Api>;
	image: ImageModel<ImageApi>;
	classifier: ClassifierModel<ClassifierApi>;
}

/** 目录条目的用途。决定 `Models` 的哪个操作接受它。 */
export type ModelType = keyof ModelTypeMap;

/** provider 能列出的任意模型。用 `isModelType()` 收窄。 */
export type AnyModel = ModelTypeMap[ModelType];
