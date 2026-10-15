import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ImageContent,
	JsonValue,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * Agent 循环使用的流函数。`Models.streamSimple` 满足这一形状。
 *
 * 循环传入的是规范化后的转录：系统提示词与工具
 * 声明由转录中的系统消息携带，而不是通过
 * `context.systemPrompt` 或 `context.tools`。
 *
 * 契约：
 * - 对请求/模型/运行时失败，不得抛异常或返回 rejected promise。
 * - 必须返回 AssistantMessageEventStream。
 * - 失败必须编码进返回的流：通过协议事件和一条
 *   终态 AssistantMessage（stopReason 为 "error" 或 "aborted"，并带 errorMessage）。
 */
export type StreamFn = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * 配置来自同一条助手消息的工具调用如何执行。
 *
 * - "sequential"（顺序）：每个工具调用先准备、执行、收尾完毕后才轮到下一个。
 * - "parallel"（并行）：各工具调用按顺序准备，随后允许的工具并发执行。
 *   `tool_execution_end` 在每个工具收尾后按完成顺序发出，
 *   而工具结果消息则在之后按助手消息中的源顺序发出。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 控制循环到达队列消费点时注入多少条排队的用户消息。
 *
 * - "all"：在消费点取出并注入全部排队消息。
 * - "one-at-a-time"：只取出最旧的一条注入，其余保留在队列中等后续消费点。
 */
export type QueueMode = "all" | "one-at-a-time";

/** 助手消息中单个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * `beforeToolCall` 的返回结果。
 *
 * 返回 `{ block: true }` 会阻止工具执行，循环改为发出一条错误工具结果。
 * `reason` 就是该错误结果显示的文本；缺省时使用默认的"已阻断"文案。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
	/**
	 * 提示：当本次调用被阻断时，Agent 应在当前工具批次结束后停止。
	 * 只有当批次内每条收尾后的工具结果都为 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/**
 * `afterToolCall` 返回的部分覆盖。
 *
 * 合并语义按字段逐个进行：
 * - `content`：若提供，整体替换工具结果的 content 数组
 * - `details`：若提供，整体替换工具结果的 details 值
 * - `isError`：若提供，整体替换工具结果的错误标志
 * - `usage`：若提供，整体替换工具结果的用量
 * - `terminate`：若提供，整体替换提前终止提示
 * - `structuredContent`：若提供，整体替换结构化内容。若只提供 `content`
 *   而不提供它，结构化内容会被丢弃，因为它可能不再与内容匹配。
 *   想保留就与 `content` 一起返回。
 *
 * 其余省略的字段保留原执行结果的值。
 * `content`、`details`、`usage` 不做深合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	/** 来自最终工具执行本身的用量（如可用）。不计入主 LLM 上下文口径。 */
	usage?: Usage;
	/**
	 * 提示：Agent 应在当前工具批次结束后停止。
	 * 只有当批次内每条收尾后的工具结果都为 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/** 传给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** 发起该工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 中的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 按目标工具 schema 校验后的参数。 */
	args: unknown;
	/** 准备工具调用时机下的当前 Agent 上下文。 */
	context: AgentContext;
}

/** 传给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** 发起该工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** `assistantMessage.content` 中的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 按目标工具 schema 校验后的参数。 */
	args: unknown;
	/** 应用任何 `afterToolCall` 覆盖之前的已执行工具结果。 */
	result: AgentToolResult<any>;
	/** 当前已执行的工具结果是否被视为错误。 */
	isError: boolean;
	/** 收尾工具调用时机下的当前 Agent 上下文。 */
	context: AgentContext;
}

/** 传给回合完成回调的上下文。 */
export interface AgentTurnContext {
	/** 完成本回合的助手消息。 */
	message: AssistantMessage;
	/** 本回合发出的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** 本回合助手消息与工具结果追加之后的当前 Agent 上下文。 */
	context: AgentContext;
	/** 若循环就此退出，本次运行将返回的消息。prompt 运行包含初始提示消息；续跑运行不包含既有上下文消息。 */
	newMessages: AgentMessage[];
}

/** {@link FinishTurn} 返回的决策。返回 undefined 保持正常调度。 */
export type AgentTurnDecision = { action: "continue" } | { action: "end" };

/**
 * 在一个助手回合及其全部工具结果消息完成之后、`turn_end` 之前调用。
 * 正常回合中，`{ action: "continue" }` 保证下一次提供商请求。工具结果、介入或
 * 后续调度本身可以满足该请求且不额外加请求；否则循环会用当前上下文再跑一次。
 * 错误与中止的响应仍是硬退出。
 */
export type FinishTurn = (
	turn: AgentTurnContext,
	signal?: AbortSignal,
) => AgentTurnDecision | void | Promise<AgentTurnDecision | undefined> | Promise<void>;

/** 在发起下一次提供商请求之前，循环使用的替换运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** 下一次提供商请求的上下文。 */
	context?: AgentContext;
	/** 在下一次提供商请求之前追加的消息，伴随正常生命周期事件。 */
	messages?: AgentMessage[];
	/** 下一次提供商请求的模型。 */
	model?: Model<any>;
	/** 下一次提供商请求的思考等级。 */
	thinkingLevel?: ThinkingLevel;
}

/** 对话式提供商请求发起瞬间的可用运行时状态。 */
export interface PrepareRequestContext {
	context: AgentContext;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
}

/** 为正在准备的提供商请求提供的替换运行时状态。 */
export type AgentRequestUpdate = Omit<AgentLoopTurnUpdate, "messages">;

/**
 * 在每次对话式提供商请求之前立即调用（包括第一次）。
 * 本回调运行时，待发消息已经追加完毕并发出。
 */
export type PrepareRequest = (
	request: PrepareRequestContext,
	signal?: AbortSignal,
) => AgentRequestUpdate | void | Promise<AgentRequestUpdate | undefined> | Promise<void>;

export interface PrepareNextTurnContext extends AgentTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * 在每次 LLM 调用前把 AgentMessage[] 转换为兼容 LLM 的 Message[]。
	 *
	 * 每条 AgentMessage 都必须转换为 LLM 能理解的 SystemMessage、UserMessage、AssistantMessage 或 ToolResultMessage。
	 * 无法转换的 AgentMessage（例如仅供 UI 的通知、
	 * 状态消息）应被过滤掉。
	 *
	 * 契约：不得抛异常或拒绝。应返回一个安全的兜底值。
	 * 抛异常会打断底层 agent 循环，无法产出正常的事件序列。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 将自定义消息转换为用户消息。
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤仅供 UI 使用的消息。
	 *     return [];
	 *   }
	 *   // 透传标准 LLM 消息。
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 可选变换：在 `convertToLlm` 之前应用于上下文。
	 *
	 * 适合在 AgentMessage 层面做的操作：
	 * - 上下文窗口管理（裁剪旧消息）
	 * - 注入来自外部源的上下文
	 *
	 * 契约：不得抛异常或拒绝。应返回原消息或另一
	 * 个安全的兜底值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 为每次 LLM 调用动态解析 API key。
	 *
	 * 适合短时效的 OAuth token（如 GitHub Copilot）——它们可能在
	 * 长时间的工具执行阶段过期。
	 *
	 * 契约：不得抛异常或拒绝。没有可用 key 时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 在助手消息与全部工具结果消息发出之后、`turn_end` 之前调用。
	 * `{ action: "end" }` 直接结束本次运行，不轮询队列、不准备下一次请求。
	 * 正常回合中，`{ action: "continue" }` 保证下一次提供商请求。工具结果、介入或
	 * 后续调度本身可以满足该请求且不额外加请求；否则循环会用当前上下文再跑一次。
	 * 返回 undefined 保持正常调度。错误与中止的响应仍是硬退出。
	 */
	finishTurn?: FinishTurn;

	/**
	 * 在每次对话式提供商请求之前立即调用（包括第一次）。
	 * 待发消息已经追加。返回的上下文、模型与思考等级
	 * 会替换本次及后续请求的运行时值。此钩子不轮询队列。
	 */
	prepareRequest?: PrepareRequest;

	/**
	 * 在 `turn_end` 之后、循环确定要继续时，下一回合开始前调用。
	 * 返回替换的上下文/模型/思考状态或待追加消息即可影响该回合。
	 * 返回 undefined 则沿用当前上下文/配置。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 返回要在运行中途注入对话的介入（steering）消息。
	 *
	 * 在当前助手回合执行完其工具调用之后调用，除非 `finishTurn` 结束了运行。
	 * 若有返回消息，会在下一次 LLM 调用前加入上下文。
	 * 当前助手消息产生的工具调用不会被跳过。
	 *
	 * 用于在 Agent 工作时"引导方向"。
	 *
	 * 契约：不得抛异常或拒绝。没有介入消息时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回在 Agent 本应停止之后要继续处理的后续（follow-up）消息。
	 *
	 * 在没有更多工具调用、也没有介入消息时调用。
	 * 若有返回消息,它们会加入上下文，Agent
	 * 继续下一个回合。
	 *
	 * 用于那些应等 Agent 做完手头工作再执行的后续消息。
	 *
	 * 契约：不得抛异常或拒绝。没有后续消息时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 工具执行模式。
	 * - "sequential"：逐个执行工具调用
	 * - "parallel"：按顺序预检工具调用，随后允许的工具并发执行；
	 *   每个工具收尾后按完成顺序发出 `tool_execution_end`，
	 *   然后按助手消息源顺序再发出工具结果消息
	 *
	 * 默认："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 在工具执行之前、参数校验完成之后调用。
	 *
	 * 返回 `{ block: true }` 可阻止执行，循环改为发出错误工具结果。
	 * 被阻断的结果也可设 `terminate: true` 参与批次的提前终止规则。
	 * 钩子会收到 agent 终止信号（abort signal），须自行遵守。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 在工具执行完成之后、`tool_execution_end` 与工具结果消息事件发出之前调用。
	 *
	 * 返回 `AfterToolCallResult` 可覆盖已执行工具结果的部分字段：
	 * - `content` 整体替换 content 数组
	 * - `details` 整体替换 details 载荷
	 * - `isError` 替换错误标志
	 * - `usage` 替换工具结果用量
	 * - `terminate` 替换提前终止提示
	 *
	 * 省略的字段保持原值，不做深合并。
	 * 钩子会收到 agent 终止信号（abort signal），须自行遵守。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 支持思考/推理功能的模型的思考等级。
 * 注意："xhigh" 与 "max" 只被部分模型家族支持。要判断具体模型是否支持，
 * 请使用 @earendil-works/pi-ai 提供的模型思考等级元数据。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 可扩展的自定义应用消息接口。
 * 应用可通过声明合并扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空 —— 应用通过声明合并扩展
}

/**
 * AgentMessage：LLM 消息 + 自定义消息的联合。
 * 该抽象让应用既能添加自定义消息类型，又不破坏
 * 类型安全，并与基础 LLM 消息保持兼容。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * 对外的 Agent 状态。
 *
 * `tools` 与 `messages` 使用存取器属性，实现方可在存入前
 * 复制被赋值的数组。
 */
export interface AgentState {
	/**
	 * 当前的 system prompt，从转录中的系统消息回放得出。
	 *
	 * 只读：要修改提示词，请追加一条带 `content` 或 `sections` 的系统消息。
	 * 在 `initialState` 中，它作为开头那条系统消息的种子。
	 */
	readonly systemPrompt: string;
	/** 供后续回合使用的当前模型。 */
	model: Model<any>;
	/** 供后续回合请求的思考等级。 */
	thinkingLevel: ThinkingLevel;
	/**
	 * 可执行工具。赋新数组时复制顶层。
	 *
	 * 与转录中已声明工具的差异，会在下一次请求前
	 * 以系统消息形式告知模型。
	 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/**
	 * 对话转录。赋新数组时复制顶层。
	 *
	 * 转录中的系统消息承载着提示词与工具声明。
	 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * Agent 正在处理提示词或续跑时为 true。
	 *
	 * 在已 await 的 `agent_end` 监听器结束之前保持为 true。
	 */
	readonly isStreaming: boolean;
	/** 当前流式响应的部分助手消息（如有）。 */
	readonly streamingMessage?: AgentMessage;
	/** 正在执行中的工具调用 id。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或被中止的助手回合的错误消息（如有）。 */
	readonly errorMessage?: string;
}

/** 工具产生的最终或部分结果。 */
export interface AgentToolResult<T = JsonValue | undefined> {
	/** 返回给模型的文本或图片内容。 */
	content: (TextContent | ImageContent)[];
	/** 供日志或 UI 渲染用的任意结构化细节。 */
	details: T;
	/**
	 * 与工具 `outputSchema` 匹配的机器可读结果，供程序化调用方使用。不会
	 * 发送给模型；`content` 才是面向模型的结果。
	 */
	structuredContent?: JsonValue;
	/** 来自最终工具执行本身的用量（如可用）。不计入主 LLM 上下文口径。 */
	usage?: Usage;
	/**
	 * 不抛异常而报告失败。模型把 `content` 当作错误结果看待（与抛出异常等效），
	 * 但 `details` 与 `structuredContent` 会保留给 UI 与程序化调用方。
	 */
	isError?: boolean;
	/**
	 * 提示：Agent 应在当前工具批次结束后停止。
	 * 只有当批次内每条收尾后的工具结果都为 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/** 各钩子运行完毕后一个工具调用的最终结果。 */
export interface AgentToolCallOutcome {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
	/** `execute()` 耗时的毫秒数，以单调时钟测量；工具未运行时缺失。 */
	durationMs?: number;
}

/**
 * 工具用来流式上报部分执行进度的回调。
 *
 * 作用域限于当前 `execute()` 调用。在工具的 promise
 * 结算之后发出的调用会被忽略。
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Agent 运行时使用的工具定义。 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** 供 UI 显示的人类可读标签。 */
	label: string;
	/**
	 * 可选兼容层：在 schema 校验之前对原始工具调用参数做修正。
	 * 必须返回符合 `TParameters` 的对象。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/**
	 * 成功结果中 `structuredContent` 的 JSON Schema。声明了它的工具应总是
	 * 设置 `structuredContent`。
	 */
	outputSchema?: TSchema;
	/**
	 * 执行工具调用。失败时要么抛异常，要么返回 `isError: true` 的结果；
	 * 不要只在 `content` 里描述失败。
	 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/** 效果的持久意图已存在、但结果未知时的恢复策略。 */
	replay?: "never" | "safe";
	/**
	 * 单工具级别的执行模式覆盖。
	 * - "sequential"：本工具必须与其他工具调用逐个执行。
	 * - "parallel"：本工具可以与其他工具调用并发执行。
	 *
	 * 省略时应用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

/** 传入底层 agent 循环的上下文快照。 */
export interface AgentContext {
	/** 对模型可见的转录。 */
	messages: AgentMessage[];
	/** 本次运行可执行的工具。 */
	tools?: AgentTool<any>[];
}

/**
 * Agent 为 UI 更新而发出的事件。
 *
 * `agent_end` 是一次运行发出的最后一个事件，但已 await 的该事件
 * `Agent.subscribe()` 监听器仍属于运行收尾的一部分。只有这些监听器
 * 结束后，Agent 才算空闲。
 */
export type AgentEvent =
	// Agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// 回合生命周期 —— 一个回合 = 一次助手响应 + 其全部工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期 —— 对 system、user、assistant、toolResult 消息都会发出
	| { type: "message_start"; message: AgentMessage }
	// 仅在流式期间对助手消息发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: any;
			isError: boolean;
			/** `execute()` 耗时的毫秒数，以单调时钟测量；工具未运行时缺失。 */
			durationMs?: number;
	  };
