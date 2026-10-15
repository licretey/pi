import type { AttachedReplicatedState, Context, JsonValue } from "@earendil-works/chord";
import type {
	AssistantMessage,
	CacheRetention,
	Message,
	Models,
	ModelThinkingLevel,
	Static,
	Tool,
	ToolCall,
	ToolResultMessage,
	Transport,
	TSchema,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ExecutionEnv, ShellOutputSkip, ShellOutputWindow } from "../env/index.ts";
import type {
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	Cursor,
	DocumentObserver,
	DocumentReader,
	EntryDraft,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Page,
	Session,
	SubmissionId,
	SubmissionRecord,
	Task,
	TaskId,
	TaskOptions,
	TaskRecord,
	TaskState,
	Tx,
	WatchHandle,
} from "../types.ts";
import type { TaskGraph, TaskGraphWatch } from "./task-graph.ts";
import type { UsageState } from "./usage.ts";
import type { ConversationView } from "./view.ts";

/** 通过 pi-ai `Models` 解析出的 provider 与 model ID。 */
export type ModelRef = {
	readonly provider: string;
	readonly modelId: string;
};

export type UserInput = UserMessage["content"];

/** 宿主提交（submission）：既可能是启动一次运行的用户输入，也可能是被动的 entry 写入。 */
export type SubmissionDraft = {
	readonly requestId?: string;
} & (
	| {
			readonly type: "input";
			readonly content: UserInput;
			readonly whenBusy?: "steer" | "followUp" | "reject";
			readonly entry?: never;
	  }
	| {
			readonly type: "write";
			readonly entry: EntryDraft;
			readonly content?: never;
			readonly whenBusy?: never;
	  }
);

export type InputSubmissionDraft = Extract<SubmissionDraft, { readonly type: "input" }>;

export type SettledSubmissionRecord = SubmissionRecord & {
	readonly status: "done" | "unanswered";
};

/** 对一次持久化接纳的 submission 可等待的宿主对象。 */
export interface Submission {
	readonly id: SubmissionId;
	status(context: Context): Promise<SubmissionRecord>;
	wait(context: Context): Promise<SettledSubmissionRecord>;
	abort(context: Context): Promise<"aborted" | "already_placed" | "settled">;
}

export type SettledTask<R> = TaskRecord<JsonValue, JsonValue, R> & {
	readonly state: Extract<TaskState<JsonValue, R>, { readonly status: "terminal" }>;
};

/** 存入 registry 的、类型擦除后的可执行 task 定义。 */
export type AnyTask = {
	readonly definition: {
		readonly name: string;
		readonly version: number;
		readonly initial: unknown;
		readonly phases: Readonly<Record<string, unknown>>;
		readonly abort: unknown;
		readonly migrate?: unknown;
		readonly hooks?: object;
	};
};

/** `Conversation.abort()` 的选项。 */
export type ConversationAbortOptions = {
	/**
	 * 跨越 background 边界：当 abort 被接纳时，无视 background 标记，把到达的每个 live task 都标记中止，撤回到达的
	 * 每个会话的排队输入，并等待这些 task 全部达到终态、会话回到普通意义上的空闲。之后再创建的 background 工作既
	 * 不会被标记，也不会被等待。
	 */
	readonly background?: boolean;
};

/** 由 task 定义声明的 hook 处理器映射。 */
export type HooksOf<K> = K extends Task<infer _I, infer _S, infer _R, infer H> ? H : never;

/**
 * 绑定到单次调用（invocation）的会话操作，供 task 与 tool 使用。调用结束后即拒绝；被动 entry 改用普通事务写入
 * 完成。
 */
export interface ConversationHandle {
	readonly id: ConversationId;
	submit(submission: InputSubmissionDraft, context: Context): Promise<Submission>;
	/** `Conversation.abort()`：撤回排队输入、中止普通所有权范围，并等待其空闲。 */
	abort(context: Context, options?: ConversationAbortOptions): Promise<void>;
	/** 当会话的普通所有权范围内不再有 live 的非 background task 时 resolve。 */
	waitForIdle(context: Context): Promise<void>;
}

/** 由工具结果请求的工具轮后（post-tools）控制。 */
export type ToolControl = {
	readonly addTools?: readonly string[];
	readonly terminate?: true;
	readonly handoff?: string;
};

/** 面向模型与 UI 的关于一次调用的备注，例如截断或落盘（spill）路径；绝不属于工具数据本身。 */
export type ToolDiagnostic = {
	readonly severity: "info" | "warn" | "error";
	readonly message: string;
	readonly code?: string;
};

/**
 * 工具的返回结果，分三个通道：`output` 给模型，`structuredOutput` 给调用工具的程序（`executeTool()` 的调用方、
 * code mode 脚本），`details` 给 UI。
 */
export type ToolExecutionResult<TDetails extends JsonValue = JsonValue> = {
	/** 给模型。省略时使用保留的 `output()` 文本。 */
	readonly output?: ToolResultMessage["content"];
	/**
	 * 给程序。当工具声明了 `structuredOutputSchema` 时必须提供（除非 `isError`），并按该 schema 校验；未声明时则
	 * 不允许提供，此时程序直接拿到输出本身（`NestedToolExecutionResult.structuredOutput`）。
	 */
	readonly structuredOutput?: JsonValue;
	readonly isError?: boolean;
	/** 省略时：最后一次 `details()` 写入的值成为 details。 */
	readonly details?: TDetails;
	/** 追加在通过 `api.diagnostic()` 记录的那些之后。 */
	readonly diagnostics?: readonly ToolDiagnostic[];
	/** 该执行自身的开销，例如某次模型调用；存储在结果上，并计入 `pi.usage.tools`。 */
	readonly usage?: Usage;
	readonly control?: ToolControl;
};

/**
 * 嵌套调用的结果，即 `executeTool()` 的返回值。程序读取 `structuredOutput`；给模型看的 output 不会被保留，
 * `control` 也不生效。
 */
export type NestedToolExecutionResult = {
	/** 该嵌套调用的工具 task。 */
	readonly taskId: TaskId;
	/**
	 * 给程序的值。带 `structuredOutputSchema` 的工具：其经过校验的 `structuredOutput`，在错误结果没有该值时缺席。
	 * 不带 schema 的工具：其有界输出（成功或错误皆然），单个文本项时为 string，单张图片时为 `ImageContent`，
	 * 无内容时为 `""`，其余为内容列表。在 Harness 自行写出的错误结果上（不可用、无效、被拦截、被中断、被中止）
	 * 缺席；出错原因由 `diagnostics` 说明。
	 */
	readonly structuredOutput?: JsonValue;
	readonly isError: boolean;
	readonly details?: JsonValue;
	readonly diagnostics: readonly ToolDiagnostic[];
	readonly usage?: Usage;
	/** 产生该结果的那次尝试的执行耗时；从未执行时缺席。 */
	readonly durationMs?: number;
};

/** 同一轮的工具是并发执行还是按调用顺序逐个执行。 */
export type ToolExecutionMode = "parallel" | "sequential";

/** 一次边界（boundary）对某模式下排队项的放置数量：放第一个，还是全部放置。 */
export type QueueMode = "all" | "one-at-a-time";

/**
 * 单次工具调用可用的操作集合。是一个普通对象，因此包装器可以用展开语法复制。调用结束后，每个操作都会拒绝。
 */
export interface ToolExecutionApi<TDetails extends JsonValue = JsonValue> extends DocumentObserver, DocumentReader {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly callId: string;
	/** 工具 task 的 phase 快照。 */
	readonly registry: RegistrySnapshot;
	/** 调用方会话的 agent，由工具 task 的 phase 解析得出。 */
	agent(context: Context): Promise<Agent>;
	/** `HarnessOptions.models`：目录（catalog）、凭证以及生成所用的请求变换。 */
	readonly models: Models;
	/** 由本次调用的 `HarnessOptions.env` 构建；没有环境配置时为 `undefined`。 */
	readonly env: ExecutionEnv | undefined;
	/**
	 * 追加运行中的输出；结果省略 `output` 时，它会成为结果的 `output`。`skipped` 计入该 chunk 之前被省略的输出量，
	 * 由配置了 `outputWindow` 的环境上报（`ShellOutputInfo.skipped`）。
	 */
	output(chunk: string | Uint8Array, skipped?: ShellOutputSkip): void;
	/**
	 * 本次调用的输出所保留的尾部，以及进度提交的节奏，对应 `ShellExecOptions.window`；当工具保留的是输出头部
	 * （无法接受 skipped）时为 `undefined`。替换了 `output` 并对文本做变换的包装器，也必须将本项替换为
	 * `undefined`，以免被跳过的文本绕过其变换。
	 */
	readonly outputWindow: ShellOutputWindow | undefined;
	/**
	 * 到目前为止保留的输出，即结果省略 `output` 时模型将看到的内容，以及更早的输出是否被丢弃；适用于同时把这段
	 * 文本放进自己 `structuredOutput` 的工具。
	 */
	retainedOutput(): { readonly text: string; readonly truncated: boolean };
	/** 记录一条模型可见的、关于本次调用的备注。 */
	diagnostic(diagnostic: ToolDiagnostic): void;
	/** 替换运行中的 details；结果省略 `details` 时，最后一次写入的值成为结果 details。 */
	details(value: TDetails, context: Context): Promise<void>;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	/**
	 * 在一次提交内创建 task。对于不保证重放安全的工具，其子 task 默认为 `abandonOnRestart`：重启后该工具不会恢复
	 * 执行，因此届时也没有谁在等待这个子 task。
	 */
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: Omit<TaskOptions, "conversationId">,
		context: Context,
	): Promise<TaskId<R>>;
	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	/** 既有会话的、绑定到本次调用的句柄，例如该工具在 `commit()` 中创建的那个会话。 */
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
	/**
	 * 以本次调用为父级、把工具 `name` 作为嵌套调用执行，并等待其结果。该嵌套调用是一个独立的 `pi.tool` task，
	 * 归本次调用所有：它会在会话的可用工具中解析该工具、做校验、执行 `ToolTask` hooks（能看见 `call.parent`）、
	 * 应用输出上限与工具的重放策略，并把进度上报到 `pi.live.nestedTools`。其结果在这里返回，而不是写入 transcript。
	 * 被拦截、无效、抛异常、被中断或被中止的调用会返回 `isError` 结果。
	 *
	 * 嵌套调用的 key 在本次调用范围内标识它；其 call ID 为 `<callId>/<key>`。默认 key 是本次调用的嵌套调用序号
	 * `1`、`2`……显式 `key` 必须非空、不含 `/`、不能是 `__proto__`、也不能是正整数，从而绝不与默认 key 冲突。
	 * 重放安全的工具重跑时，若以相同顺序调用或传入相同 `key` 再次发起已有 key 的调用，则取回那个嵌套调用（无论
	 * 已完成还是仍在运行），而不是新启动一个。被崩溃打断且结果尚未提交的嵌套调用遵循其自身的重放策略，因此这并
	 * 非严格的一次性（exactly-once）执行。相同 key 却配了不同工具或不同参数时抛错。不保证重放安全的工具绝不重跑：
	 * 重启后，其未完成的嵌套调用会先被放弃（`TaskOptions.abandonOnRestart`），而不会再次执行。
	 *
	 * `progress: false` 时，不向嵌套调用的 slot 提交任何运行中输出、details 或 diagnostics，只提交其状态；结果仍会
	 * 携带其 details 与 diagnostics，以及无 schema 工具以 `structuredOutput` 形式给出的输出。被中断或被中止的调用，
	 * 其结果由其 slot 重建，因此届时这些字段一概没有。无论哪种方式，程序都不会拿到被中断或被中止调用的部分输出。
	 *
	 * 嵌套调用一经发起即开始运行，与 `executionMode` 无关；调用方通过自己 await 什么来决定什么并发执行。取消
	 * `context` 只会停止等待，嵌套调用继续运行。当本次调用 settle 时，其遗留未完成的嵌套调用会先被中止。嵌套结果
	 * 的 `usage` 已计入其工具名下；若结果又把它向上传递，则会被重复计入。一旦 `execute()` 已返回、本次调用被中止
	 * 或 Harness 已关闭，则直接拒绝（reject），而不再返回结果。
	 */
	executeTool(
		name: string,
		args: JsonObject,
		context: Context,
		options?: { readonly key?: string; readonly progress?: boolean },
	): Promise<NestedToolExecutionResult>;
}

/**
 * 注册进 registry 的可执行工具。只有 pi-ai `Tool` 的字段会进入 transcript。`args` 的类型由 `parameters` 决定，
 * Harness 在 `execute()` 之前会按它校验；`defineTool()` 会推导这两个泛型。
 */
export type ToolRegistration<
	TParameters extends TSchema = TSchema,
	TDetails extends JsonValue = JsonValue,
> = Tool<TParameters> & {
	/** 被中断的执行在恢复后是否可以重跑。默认 `unsafe`。 */
	readonly replay?: "safe" | "unsafe";
	/** 默认取 settings 的 `toolExecution`。一个顺序执行的调用会把它的整轮都变成顺序执行。 */
	readonly executionMode?: ToolExecutionMode;
	/**
	 * 在校验之前，修复模型常弄错的参数，例如把 JSON 字符串放到本该是数组的位置。必须是纯函数，且不得改动
	 * `args`：在调用意图被记录之前重试时它会再次执行。其结果仍会按 `parameters` 校验。
	 */
	prepareArguments?(args: unknown): Static<TParameters>;
	/**
	 * `structuredOutput` 的 schema，即调用该工具的程序会收到的值。省略时：这些程序收到结果的有界输出（成功或
	 * 错误皆然），如 `NestedToolExecutionResult.structuredOutput` 所述。
	 */
	readonly structuredOutputSchema?: TSchema;
	/**
	 * 谁可以调用该工具：模型、经由 `executeTool()` 的其他工具，或两者（默认）。code mode 工具是 `["model"]`，
	 * 因此脚本无法启动脚本；藏在 code mode 之后的工具（例如 MCP 工具）可以是 `["tools"]`，这样模型永远不会被
	 * 直接提供它们。
	 */
	readonly callers?: readonly ("model" | "tools")[];
	readonly outputLimits?: {
		readonly maxBytes?: number;
		readonly maxLines?: number;
		readonly retain?: "head" | "tail";
	};
	execute(
		args: Static<TParameters>,
		api: ToolExecutionApi<TDetails>,
		context: Context,
	): Promise<ToolExecutionResult<TDetails>>;
};

/** 一次请求准备（request preparation）的系统提示各节（section）渲染的输入。 */
export type PromptInput<Tool extends ToolRegistration = ToolRegistration> = {
	readonly conversationId: ConversationId;
	/** 本次请求的解析结果；`agent.tools` 即本次请求提供（offer）的工具。 */
	readonly agent: Agent<Tool>;
	/** 由 `HarnessOptions.env` 为本次准备构建；无环境时为 `undefined`。 */
	readonly env: ExecutionEnv | undefined;
	/** 重放-active transcript 之后已生效的各节。 */
	readonly shown: Readonly<Record<string, string>>;
	/** 已提交的文档读取。 */
	readonly read: DocumentReader;
};

/** 一个系统提示节；agent 的各节会在每次请求前按顺序渲染。 */
export type PromptSection<Tool extends ToolRegistration = ToolRegistration> = {
	readonly key: string;
	render(input: PromptInput<Tool>, context: Context): string | undefined | Promise<string | undefined>;
	/** 默认 true：把文本包成 `<key>\n...\n</key>`。 */
	readonly tag?: boolean;
};

/** 由 `hook()` 构建；按名称匹配 task。 */
export type HookRegistration = { readonly task: string; readonly handlers: object };

/** 由 `wrapTool()` 与 `wrapSection()` 构建；目标是某个工具名或某个 section key。包装器必须为纯函数。 */
export type Wrap<Tool extends ToolRegistration = ToolRegistration> =
	| { readonly tool: string; wrap(tool: Tool): Tool }
	| { readonly section: string; wrap(section: PromptSection<Tool>): PromptSection<Tool> };

/** 具名的 code 集合；安装进 registry，并由会话按名称选用。 */
export interface Extension<Tool extends ToolRegistration = ToolRegistration> {
	readonly name: string;
	readonly tools?: readonly Tool[];
	readonly sections?: readonly PromptSection<Tool>[];
	readonly hooks?: readonly HookRegistration[];
	/** 在该扩展被选中的所有位置按顺序应用。 */
	readonly wraps?: readonly Wrap<Tool>[];
	/** 按名称为每个 task 解析，无论哪些会话选中了该扩展。 */
	readonly tasks?: readonly AnyTask[];
}

/** 一次已发布的 registry 状态的不可变视图。 */
export interface RegistrySnapshot<Tool extends ToolRegistration = ToolRegistration> {
	installed(): readonly Extension<Tool>[];
	extension(name: string): Extension<Tool> | undefined;
	/** 所有已安装工具及其所属扩展，按安装顺序。不同扩展间名称可以重复。 */
	tools(): readonly { readonly extension: Extension<Tool>; readonly tool: Tool }[];
	sections(): readonly { readonly extension: Extension<Tool>; readonly section: PromptSection<Tool> }[];
	/** 内置的与已安装的 task 定义。 */
	tasks(): readonly AnyTask[];
	task(name: string): AnyTask | undefined;
}

/** Harness 所消费的 registry 的读取端。 */
export interface RegistryReader<Tool extends ToolRegistration = ToolRegistration> {
	/** 整个当前 registry 的不可变视图。 */
	snapshot(): RegistrySnapshot<Tool>;
	/** 每次发布之后同步调用；唤醒调度器以重新评估被阻塞的 task。 */
	subscribe(listener: () => void): () => void;
}

/** 由应用持有的扩展 registry。 */
export interface Registry<Tool extends ToolRegistration = ToolRegistration> extends RegistryReader<Tool> {
	/** 安装 `extension`，或就地替换已安装的同名扩展。立即发布。 */
	install(extension: Extension<Tool>): void;
	/** 移除已安装的名为 `extension.name` 的扩展，无论其对象是谁。之后的安装将重新追加。 */
	uninstall(extension: Extension): void;
}

/** 某个会话存储的偏好；存名称而非对象。未设置的字段沿用宿主（host）默认。 */
export type AgentState = {
	model?: ModelRef;
	thinkingLevel?: ModelThinkingLevel;
	/** 用数组表示恰好选中这些扩展、并保持该顺序。对象形式则用于编辑宿主默认选择。 */
	extensions?: string[] | { add?: string[]; remove?: string[] };
	/** 过滤被选中扩展的工具：得到启用的工具。数组形式表示恰好启用这些、并保持该顺序。 */
	tools?: string[] | { remove: string[] };
	/**
	 * 过滤启用工具中模型可以调用的部分（`callers` 含 `model`）：即提供给模型的工具。数组形式表示恰好提供这些、
	 * 并保持该顺序。绝不放宽：模型名下剔除的工具，其他工具仍可调用。
	 */
	modelTools?: string[] | { remove: string[] };
	/** 在每个扩展 section 之后渲染，即 section `instructions`。 */
	instructions?: string;
	/** 环境文件系统中的目录，传给 `HarnessOptions.env`。 */
	cwd?: string;
};

/** 对 `pi.agent` 的一次变更：给定字段则替换存储值，`null` 清除，`undefined` 不做任何改变。 */
export type AgentChange = {
	readonly model?: ModelRef | null;
	readonly thinkingLevel?: ModelThinkingLevel | null;
	readonly extensions?:
		| readonly Extension[]
		| { readonly add?: readonly Extension[]; readonly remove?: readonly Extension[] }
		| null;
	readonly tools?: readonly ToolRegistration[] | { readonly remove: readonly ToolRegistration[] } | null;
	readonly modelTools?: readonly ToolRegistration[] | { readonly remove: readonly ToolRegistration[] } | null;
	readonly instructions?: string | null;
	readonly cwd?: string | null;
};

/** 某个会话的 agent，基于一个 registry 快照与 settings 解析得出。 */
export type Agent<Tool extends ToolRegistration = ToolRegistration> = {
	readonly model?: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly extensions: readonly Extension<Tool>[];
	/** 一次请求提供的工具，按顺序：已启用、可被模型调用，且被 `modelTools` 选中。 */
	readonly tools: readonly Tool[];
	/** 嵌套调用(`executeTool()`)在其中解析工具的集合,按顺序:已启用且可被工具调用。 */
	readonly callable: readonly Tool[];
	/** 扩展各节,当 `instructions` 已设置时排在其后。 */
	readonly sections: readonly PromptSection<Tool>[];
	readonly instructions?: string;
	readonly cwd?: string;
};

/**
 * 在创建它的那次提交内运行,时机在创建 hook 与 `agent` 变更之后。整个会话的创建此时已经是表写入,因此这里的表读
 * 会抛 `ReadAfterWrite`;文档访问仍然可用。
 */
export type ConversationInit = (tx: Tx, conversationId: ConversationId) => void | Promise<void>;

export type ConversationCreateOptions = {
	readonly ownership: ConversationOwnership;
	/** 在创建提交内、创建 hook 的副本之后、`init` 之前应用。 */
	readonly agent?: AgentChange;
	readonly init?: ConversationInit;
};

/** 精选过的 pi-ai 请求选项;缺席字段使用 pi-ai 的默认值。 */
export type ConversationStreamOptions = {
	transport?: Transport;
	timeoutMs?: number;
	/** 单次请求尝试内部，provider/SDK 层面的重试。 */
	maxRetries?: number;
	maxRetryDelayMs?: number;
	headers?: Record<string, string>;
	metadata?: JsonObject;
	cacheRetention?: CacheRetention;
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
};

/** 持久化的生成尝试重试策略；pi-ai `RetryPolicy` 的 JSON 形态。 */
export type ConversationRetryPolicy = {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs?: number;
};

/** 自动压缩（compaction）阈值（spec §8.7）；手动压缩忽略 `enabled`。 */
export type CompactionPolicy = {
	/** 阈值与溢出压缩的开关。 */
	enabled: boolean;
	/** 为回答保留的余量：超过 `contextWindow - reserveTokens` 时，生成会阻塞以先做压缩。 */
	reserveTokens: number;
	/** 摘要中原样保留的近期上下文的大致规模。 */
	keepRecentTokens: number;
	/** 后台压缩在阻塞阈值之下 `backgroundTokens` 处启动；`0` 表示禁用。 */
	backgroundTokens: number;
};

/**
 * 运行进度提交的频率。每次进度提交都是一次存储写入；存储在远端的宿主可以降低提交频率，这样 live 回答与工具
 * 输出会以更大的步幅出现。
 */
export type ProgressPolicy = {
	/** 正在生成的回答，两次提交之间的最小间隔。 */
	partialIntervalMs: number;
	/** 运行中工具输出两次提交之间的最小间隔；大体量提交还会按其规模成比例地追加间隔。 */
	outputIntervalMs: number;
};

/** 触发一次压缩的原因：`compact()`、生成准备中的阈值，还是上下文溢出。 */
export type CompactionReason = "manual" | "threshold" | "overflow";

/**
 * 阻塞式压缩摘要的 `entryId`，或会话自有（conversation-owned）压缩的摘要写入对应的 `submissionId`；两者在
 * 未发生压缩时皆缺席。
 */
export type CompactionResult = { entryId?: EntryId; submissionId?: SubmissionId };

/** Harness 级别的运行策略。每次解析时读取且从不复制；getter 没问题。必须同步：部分读取端运行在 Session 线上。 */
export type HarnessSettings = {
	/** 默认扩展选择；缺席时：所有已安装扩展，按安装顺序。 */
	readonly extensions?: readonly Extension[];
	readonly stream?: ConversationStreamOptions;
	readonly retry?: Partial<ConversationRetryPolicy>;
	readonly compaction?: Partial<CompactionPolicy>;
	readonly progress?: Partial<ProgressPolicy>;
	readonly toolExecution?: ToolExecutionMode;
	readonly steeringMode?: QueueMode;
	readonly followUpMode?: QueueMode;
	/**
	 * 空闲会话在内存中保留其最后一次上下文读取的时长，使其下次运行只需读取更新的 entry。忙会话总是保留；
	 * `0` 表示会话一旦空闲就丢弃。
	 */
	readonly contextRetentionMs?: number;
};

/** 已解析的 settings：每个字段都覆盖其内置默认值，对象字段做合并。 */
export type Settings = {
	/** 缺席时：所有已安装扩展，按安装顺序。 */
	readonly extensions?: readonly Extension[];
	readonly stream: ConversationStreamOptions;
	readonly retry: ConversationRetryPolicy;
	readonly compaction: CompactionPolicy;
	readonly progress: ProgressPolicy;
	readonly toolExecution: ToolExecutionMode;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	readonly contextRetentionMs: number;
};

/** `HarnessOptions.env` 为之构建环境的对象。 */
export type EnvTarget = {
	readonly conversationId: ConversationId;
	/** 会话的 agent `cwd`。 */
	readonly cwd?: string;
	readonly read: DocumentReader;
};

export type HarnessOptions<Tool extends ToolRegistration = ToolRegistration> = {
	/** pi-ai 模型访问能力，由生成过程使用。 */
	readonly models: Models;
	readonly registry: RegistryReader<Tool>;
	readonly settings?: HarnessSettings;
	/** 每次使用时构建会话的环境。绝不会在 Session 线上调用；可以是异步的。 */
	readonly env?: (target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
	/**
	 * 在每个创建或 fork 会话的提交内运行，包括原始的 `tx.createConversation()`，时机在内置 `pi.*` 文档之后、
	 * 便捷方法应用 `agent` 并执行 `init` 之前。fork 的会话此时已带上其副本。与 `init` 一样，表读取会抛
	 * `ReadAfterWrite`；抛错则使创建提交失败。
	 */
	readonly conversationCreated?: (tx: Tx, conversation: ConversationRecord) => void | Promise<void>;
	readonly now?: () => number;
	/**
	 * 接收那些不会使调用操作失败的错误，例如抛异常的 hook 或 listener，以及使 Session 失败的那个错误，且每个
	 * 错误只接收一次。它自身的 throw 或 rejection 会被丢弃。
	 */
	readonly onReport?: (error: unknown) => void;
};

/** live task，以及调度器在当前 registry 下会怎么处理它。 */
export type TaskInspection = {
	readonly record: TaskRecord<JsonValue, JsonValue, JsonValue>;
	readonly state: /** 一次调用（invocation）正在执行。 */
		| { readonly kind: "running" }
		/** 下一次调度轮次将预留它；当其定义更新且带 `migrate` 时 `migrates` 为真。 */
		| { readonly kind: "ready"; readonly migrates: boolean }
		/**
		 * 等待以下这些 live task：其 `on` 中的 live 部分，或在已标记中止时，其 live 的普通自有工作——后者必须在
		 * 其 abort handler 启动前结束。
		 */
		| { readonly kind: "waiting"; readonly on: readonly TaskId[] }
		/** 结果被扣住，直到其普通自有工作排空。 */
		| { readonly kind: "completing" }
		/** 没有任何已注册定义可以接管它；中止它将以 `orphaned` 终态落定。 */
		| {
				readonly kind: "blocked";
				readonly reason: "missing_task" | "task_too_old" | "migration_failed";
				readonly error?: unknown;
		  };
};

/** live 工作的即时视图：未完成的 task 与 submission，在 Session 线上读取。 */
export type HarnessInspection = {
	readonly scheduling: "paused" | "running" | "closing";
	readonly tasks: readonly TaskInspection[];
	/** 已排队与已放置的 submission，按 ID 顺序。 */
	readonly submissions: readonly SubmissionRecord[];
};

/** 原始 active transcript 与派生的模型上下文。 */
export type ContextView = {
	/** 最新适用的 head 标记（如存在）。 */
	readonly head: EntryRecord | undefined;
	/** 原始 active entries：head 标记，随后是其 head 至尾部的非 head entry。 */
	readonly entries: readonly EntryRecord[];
	/** 对 `entries` 中的每个 entry，其在编辑与排除的 stop reason 之后、工具结果排序之前的模型消息。 */
	readonly contributions: readonly (readonly Message[])[];
	/** 下一次 provider 请求的模型上下文。 */
	readonly messages: readonly Message[];
};

/** 面向单个会话的无状态句柄，绑定于返回它的 Harness。按 `id` 比较句柄。 */
export interface Conversation {
	readonly id: ConversationId;

	/** 基于当前 registry 快照与 settings 解析。 */
	agent(context: Context): Promise<Agent>;
	/** 单独一次提交内的 `configure()`。 */
	configure(change: AgentChange, context: Context): Promise<void>;

	/**
	 * 持久化接纳用户输入或被动 entry 写入。忙会话，或存在排队项的会话，会将其排队进 `pi.inbox`；设为
	 * `whenBusy: "reject"` 时则改为拒绝并抛 `ConversationBusy`，且不写任何内容。
	 */
	submit(submission: SubmissionDraft, context: Context): Promise<Submission>;
	/**
	 * 接纳一条启动全新上下文的 `pi.reset` entry 写入，若给定 `handoff` 则作为 user message 带上。接纳后即
	 * resolve；忙时将放置在下一个边界。
	 */
	reset(handoff: string | undefined, context: Context): Promise<void>;
	/**
	 * 接纳一个手动压缩 task 并返回其 ID。它在会话继续工作的同时做摘要，并通过写 submission 放置其摘要：空闲时
	 * 立即放置，否则在下一个边界（spec §8.7）。
	 */
	compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>>;

	/** 以本会话为默认 `tx.createTask()` 目标的 Session commit。 */
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	/**
	 * 已提交的原始 active transcript 与模型上下文。给定 `at` 时，返回截至该可见 entry 的上下文：即 `fork(at)` 将
	 * 以之开始的同一视图，只是不创建会话。
	 */
	context(context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
	/** 本会话的分叉感知历史，除非 `query.order` 为 `ascending`，否则最新在前。 */
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation>;
	/**
	 * 撤回排队输入（排队的写入不受影响），标记普通所有权范围内的所有 live 非 background task 并发出中止信号，
	 * 然后在范围空闲时 resolve。除非设置了 `background`，background 子树会存活。
	 */
	abort(context: Context, options?: ConversationAbortOptions): Promise<void>;
	/**
	 * 普通所有权范围内没有 live 非 background task 时 resolve：包括本会话，以及由其非 background task 传递性
	 * 拥有的会话。
	 */
	waitForIdle(context: Context): Promise<void>;
	/** 结构化视图（spec §9.3），以一次性的只读 Chord 状态形式给出。 */
	viewState(context: Context): Promise<AttachedReplicatedState<ConversationView>>;
	/** 结构化视图，以带有限 pending frame 的序列化精确帧 watch 形式给出。 */
	watch(context: Context): Promise<ConversationWatch>;
}

export type ConversationWatch = WatchHandle<ConversationView>;

/** 构建于一个 Session 之上的持久 agent Harness。 */
export interface Harness extends Session {
	/**
	 * 启用 task 调度。幂等；close 之后抛错。请求进度的调用也会启用它：`Conversation.submit()`、
	 * `Conversation.compact()`、`Conversation.abort()`、`Submission.wait()`、`waitForTask()`、
	 * `Harness.waitForIdle()` 与 `Conversation.waitForIdle()`。只读 viewer 从不这样做。
	 */
	resume(): void;

	/** 返回预留的根会话；缺席时用 `agent` 与 `init` 在一次提交内创建它。 */
	root(
		context: Context,
		options?: { readonly agent?: AgentChange; readonly init?: ConversationInit },
	): Promise<Conversation>;
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation>;

	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined>;
	/** live task 与未落定的 submission。不写任何内容，也不运行任何 task 代码。 */
	inspect(context: Context): Promise<HarnessInspection>;
	/** 重新获取一个 submission，例如 reopen 之后。 */
	submission(id: SubmissionId, context: Context): Promise<Submission | undefined>;
	/** 未知 submission，或不属于 `conversationId` 的另一个会话的 submission，返回 `not_found`。 */
	abortSubmission(
		id: SubmissionId,
		context: Context,
		conversationId?: ConversationId,
	): Promise<"aborted" | "already_placed" | "settled" | "not_found">;
	/**
	 * 提交中止标记、向活动的 run 调用发信号并 join 它，再调度 abort 调用。定义无法接管该 task 时，task 改为以
	 * `orphaned` 落定。
	 */
	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal">;
	/** 以终态回执 resolve；取消 `context` 只会取消这一次等待。 */
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
	/** 当所有无主会话的普通所有权范围都没有 live 非 background task 时 resolve。 */
	waitForIdle(context: Context): Promise<void>;
	/** Session 总量：所有会话的 `pi.usage` 之和。 */
	usage(context: Context): Promise<UsageState>;
	/** 每个 live task 及其 owner 边、状态与拥有的会话（spec §9.5），以一次性 Chord 状态形式给出。 */
	taskGraph(context: Context): Promise<AttachedReplicatedState<TaskGraph>>;
	/** task graph，以带有限 pending frame 的序列化精确帧 watch 形式给出。 */
	watchTaskGraph(context: Context): Promise<TaskGraphWatch>;
}

/** hook 可用的能力：已提交的读取，以及发起调用的 task 的 memos（hooks 与该 task 共享）。 */
export interface HookApi extends DocumentReader {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	/** `HarnessOptions.models`。 */
	readonly models: Models;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
}

export type HookResult<T> = T | undefined | Promise<T | undefined>;

/** 内置生成 task 的 hooks。 */
export interface GenerationHooks {
	/** 每次请求尝试之前（含恢复），其结果只作用于该次请求。 */
	beforeRequest(
		request: { readonly messages: readonly Message[] },
		api: HookApi,
		context: Context,
	): HookResult<{ readonly messages: readonly Message[] }>;
	/** 每条终态 provider 消息，在分类之前。 */
	afterResponse(message: AssistantMessage, api: HookApi, context: Context): void | Promise<void>;
	/** 一次最终回答；首个 `continue` 会追加一条 user message 并继续运行。 */
	onYield(answer: AssistantMessage, api: HookApi, context: Context): HookResult<{ readonly continue: UserInput }>;
	/** 本轮每个工具都终态之后；`results` 是本轮的结果 entry，按调用顺序。 */
	afterTools(assistant: EntryId, results: readonly EntryId[], api: HookApi, context: Context): void | Promise<void>;
}

/** 工具 hooks 眼中的调用；嵌套调用（一个运行中的工具经 `executeTool()` 发起的调用）会设置 `parent`。 */
export type ToolHookCall = ToolCall & {
	readonly parent?: { readonly taskId: TaskId; readonly callId: string };
};

/** 内置工具 task 的 hooks，覆盖模型发起的与嵌套的调用。 */
export interface ToolHooks {
	/** 意图之前；首个 `block` 生效，否则 `arguments` 替换该调用的参数。抛错即拦截。 */
	beforeTool(
		call: ToolHookCall,
		api: HookApi,
		context: Context,
	): HookResult<{ readonly arguments?: JsonObject; readonly block?: string }>;
	/** 执行之后、结果提交之前；替换该结果。 */
	afterTool(
		call: ToolHookCall,
		result: ToolExecutionResult,
		api: HookApi,
		context: Context,
	): HookResult<ToolExecutionResult>;
}

/** 内置压缩 task 的 hooks。 */
export interface CompactionHooks {
	/**
	 * 范围选定之后、摘要之前；首个决策生效。`entries` 是该摘要要替换的 active entries（head 标记在最前），
	 * `messages` 是它们的模型上下文、即摘要器的输入源；`firstKept` 是第一个逐字保留的 entry。
	 */
	beforeCompact(
		compaction: {
			readonly reason: CompactionReason;
			readonly entries: readonly EntryRecord[];
			readonly messages: readonly Message[];
			readonly firstKept: EntryId;
			readonly instructions?: string;
		},
		api: HookApi,
		context: Context,
	): HookResult<{ readonly decline: true } | { readonly summary: string }>;
}
