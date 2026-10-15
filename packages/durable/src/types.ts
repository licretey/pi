import type { AttachedReplicatedState, Context, Draft, JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type { Message, Models } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "./env/index.ts";
import type {
	Agent,
	ContextView,
	ConversationHandle,
	RegistrySnapshot,
	Settings,
	SettledTask,
} from "./harness/types.ts";

/** 用作每个 durable document 根的 JSON 对象。 */
export type JsonObject = { [key: string]: JsonValue };

declare const idBrand: unique symbol;

/** 已擦除的标称数字，标识一种 durable record 类别。 */
export type Id<Kind extends string, Type = unknown> = number & {
	readonly [idBrand]: {
		readonly kind: Kind;
		readonly type: Type;
	};
};

export type ConversationId = Id<"conversation">;
export type EntryId = Id<"entry">;
export type TaskId<Result = unknown> = Id<"task", Result>;
export type SubmissionId = Id<"submission">;
export type DocumentId = Id<"document">;

declare const seqBrand: unique symbol;

/** 分配给一次原子 storage commit 的严格递增序列；允许出现空洞。 */
export type Seq = number & { readonly [seqBrand]: "sequence" };

/** 根 conversation 始终使用该保留 ID。 */
export const ROOT_CONVERSATION_ID = 1 as ConversationId;

/** 只保留当前状态的 conversation document。 */
export type LatestConversationSemantics = {
	readonly scope: "conversation";
	readonly history: "latest";
	readonly fork: "current" | "initial";
};

/** 历史仍可寻址、支持 as-of 读取的 conversation document。 */
export type RewindableConversationSemantics = {
	readonly scope: "conversation";
	readonly history: "rewindable";
	readonly fork: "asOf" | "current" | "initial";
};

/** document 的归属与生命周期；只有 conversation document 声明 history 与 fork 行为。 */
export type DocumentSemantics =
	| { readonly scope: "session"; readonly history?: never; readonly fork?: never }
	| LatestConversationSemantics
	| RewindableConversationSemantics
	| { readonly scope: "task"; readonly history?: never; readonly fork?: never };

/** 提供给 document checkpoint 谓词的已存重放状态。 */
export type CheckpointInfo = {
	/** newest base 之后已存储的 delta 数量，不含正在评估的变更。 */
	readonly deltasSinceBase: number;
};

/** 单例 document 与 document family 共有的定义字段。 */
export type CommonDocDefinition<T extends JsonObject> = {
	/** 稳定且持久化的 kind；属于公开协议的一部分。 */
	readonly kind: string;
	/** 存储值形状的正整数版本号。 */
	readonly version: number;
	initial(): T;
	migrate?(value: JsonObject, fromVersion: number): T;
	/** 返回 true 时，将本次普通变更存储为完整 base 而非 delta。 */
	checkpointWhen?(value: Readonly<T>, ops: readonly Op[], info: CheckpointInfo): boolean;
};

/** 单例 document 定义。 */
export type DocDefinition<T extends JsonObject> = CommonDocDefinition<T> & DocumentSemantics;

/** 键控 document family 定义；`initial(seed)` 仅在成员不存在时执行。 */
export type DocFamilyDefinition<T extends JsonObject, I extends JsonValue> = Omit<CommonDocDefinition<T>, "initial"> &
	DocumentSemantics & {
		readonly family: true;
		initial(seed: I): T;
	};

declare const docType: unique symbol;

/** 传给类型化访问的显式单例 document token。 */
export interface DocToken<T extends JsonObject, D extends DocDefinition<T>> {
	readonly definition: D;
	readonly [docType]?: T;
}

/** 传给类型化访问的显式 document family token。 */
export interface DocFamilyToken<T extends JsonObject, I extends JsonValue, D extends DocFamilyDefinition<T, I>> {
	readonly definition: D;
	readonly [docType]?: T;
}

export type SessionDocToken<T extends JsonObject> = DocToken<T, CommonDocDefinition<T> & { readonly scope: "session" }>;
export type ConversationDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
export type RewindableConversationDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & RewindableConversationSemantics
>;
export type TaskDocToken<T extends JsonObject> = DocToken<T, CommonDocDefinition<T> & { readonly scope: "task" }>;

export type SessionDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & { readonly scope: "session" }
>;
export type ConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
export type RewindableConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & RewindableConversationSemantics
>;
export type TaskDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & { readonly scope: "task" }
>;

/** 被一次 invocation 预留的活跃 task record。 */
export type RunningTask<I, S, R> = TaskRecord<I, S, R> & {
	readonly state: Extract<TaskState<S, R>, { readonly status: "running" }>;
};

/**
 * task 为自身提交的下一个状态：替换 checkpoint、进入等待，或其最终结果。当 task 之下的普通 owned work 仍在运行时，
 * 返回的 `terminal` 状态会以 `completing` 形式存储（spec §5.5）。
 */
export type NextTaskState<S, R> = Extract<TaskState<S, R>, { readonly status: "running" | "waiting" | "terminal" }>;

/**
 * 运行一个 checkpoint 阶段。它必须通过 `runtime.commit()` 提交变更后的 checkpoint 或终态结果；
 * 未产生持久化进度就返回会触发 task fault。
 */
export type PhaseHandler<I, P, S, R, H extends object> = (
	task: RunningTask<I, P, R>,
	runtime: TaskRuntime<I, S, R, H>,
	context: Context,
) => Promise<void>;

/** 按 phase snapshot 的注册表顺序，将 task 的一个 hook 分发给每个匹配的已注册 handler。 */
export interface HookRunner<H extends object> {
	/**
	 * 以每个名为 `name` 的匹配 handler 调用 `invoke`。`invoke` 的普通抛错会被上报并继续执行下一个
	 * handler；一旦 invocation 已被 signal，错误则向外传播。组合逻辑发生在 `invoke` 内部。
	 */
	each<K extends keyof H>(name: K, invoke: (handler: NonNullable<H[K]>) => void | Promise<void>): Promise<void>;
}

/**
 * 一次 task invocation 的操作集合。invocation 结束后每个操作都会 reject；通过它获取的
 * watch 在 invocation 结束时停止。
 */
export interface TaskRuntime<I, S, R, H extends object> extends DocumentObserver, DocumentReader {
	readonly taskId: TaskId<R>;
	readonly conversationId: ConversationId;
	/**
	 * 在 `abortTask()` signal 该 run、Harness 关闭或 invocation 结束时被 abort。invocation 结束后仍在使用它的
	 * 工作（例如 detached wait）会被取消；反正它们也无法再写入任何内容。
	 */
	readonly signal: AbortSignal;
	/** 当前 phase 的注册表快照；在每个 phase 边界刷新。 */
	readonly registry: RegistrySnapshot;
	/** task 所属 conversation 的 agent，每个 phase 至多解析一次（首次使用时），且在该 phase 内固定不变。 */
	agent(context: Context): Promise<Agent>;
	/** `HarnessOptions.settings`，每次访问时重新解析。 */
	readonly settings: Settings;
	readonly models: Models;
	/** 为 task 的 conversation 调用 `HarnessOptions.env`；出错时以该错误 reject。 */
	env(context: Context): Promise<ExecutionEnv | undefined>;
	/** 来自该 conversation 所选扩展的、与 task 同名的各 handler，按扩展顺序排列。 */
	readonly hooks: HookRunner<H>;

	/**
	 * 在重新读取 task 后，于 Session mutation line 上提交。task 已终态、invocation 已结束、Harness 正在关闭，
	 * 或（run invocation 中）task 带有 abort mark 时会 reject。返回的状态会在同一次提交中替换 task 的
	 * 状态；不返回任何内容则保持不变。`tx.createTask()` 默认使用 task 的 conversation。
	 */
	commit(
		change: (
			tx: Tx,
			current: RunningTask<I, S, R>,
		) => NextTaskState<S, R> | undefined | Promise<NextTaskState<S, R> | undefined>,
		context: Context,
	): Promise<void>;
	/** 读取该 task 的一条持久化 memo。 */
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	/** 若 memo 已存在则不存储 `candidate`；返回持久化后的胜出者。 */
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	/** 已提交的 task record。 */
	getTask<T>(id: TaskId<T>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, T> | undefined>;
	/** 以该 task 的终态回执 resolve；invocation 结束时 reject。 */
	waitForTask<T>(id: TaskId<T>, context: Context): Promise<SettledTask<T>>;
	/**
	 * 像 `Harness.abortTask()` 那样 abort 该 task 拥有的 task，并在其到达终态后 resolve。
	 * abort 他人拥有的 task 会 reject；已是终态的 task 立即 resolve。
	 */
	abortOwned(id: TaskId, context: Context): Promise<void>;
	/** 按顺序返回终态 task 的 outcome；任一缺失或未终态都会 reject。通常在等待之后使用。 */
	outcomes<T>(ids: readonly TaskId<T>[], context: Context): Promise<TaskOutcome<T>[]>;
	/**
	 * 已有 conversation 的 invocation 绑定句柄，例如该 task 拥有的 conversation；不存在时为 `undefined`。
	 * invocation 结束后其操作及返回的 submission 都会 reject；已接纳的工作保持持久化。
	 */
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
	/** 从该 task 的 conversation 可见的已提交 entry。 */
	entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
	/** entry 不存在、不可见或 kind 不同时为 undefined。 */
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId, context: Context): Promise<TypedEntry<D> | undefined>;
	/** 已提交的原始活跃 transcript 与 model context，可选地在可见 entry `at` 处截断。 */
	context(conversationId: ConversationId, context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
	/** Harness 的时钟。 */
	now(): number;
	/** 将非致命失败转发给 `HarnessOptions.onReport`。 */
	report(error: unknown): void;
	/** Harness 时钟到达 `until` 时 resolve；invocation 或 `context` 被取消时 reject。 */
	sleep(until: number, context: Context): Promise<void>;
}

/** 可执行的 durable 状态机定义，以 `name` 注册到注册表中。 */
export type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
	/** 持久化在 `TaskRecord.kind` 中的已注册 task kind。 */
	readonly name: string;
	/** 与活跃输入和 checkpoint 一起持久化的定义版本号。 */
	readonly version: number;
	/** 新建 task 的首个持久化 checkpoint。 */
	initial(input: I): S;
	/** 穷尽的 phase 映射；每个 handler 收到的 task 已收窄到对应 phase。 */
	readonly phases: {
		readonly [P in S["phase"]]: PhaseHandler<I, Extract<S, { phase: P }>, S, R, H>;
	};
	/** 在 abort mark 之后由全新 invocation 运行，且必须提交一个终态结果。 */
	abort(task: RunningTask<I, S, R>, runtime: TaskRuntime<I, S, R, H>, context: Context): Promise<void>;
	/** 转换任意更旧的支持版本所存的 record；在保留（reservation）时运行。 */
	migrate?(
		input: JsonValue,
		checkpoint: JsonValue,
		fromVersion: number,
	): {
		input: I;
		checkpoint: S;
	};
	readonly hooks?: H;
};

/** 类型化的可执行 task 定义。 */
export interface Task<I, S extends { phase: string }, R, H extends object> {
	readonly definition: TaskDefinition<I, S, R, H>;
}

/** task 的归属者：其 conversation（顶层 task）或同一 conversation 的另一 task（子 task）。 */
export type TaskOwnership = { readonly kind: "conversation" } | { readonly kind: "task"; readonly taskId: TaskId };

/** 等待中的 task 如何对待它所等待的 task（spec §5.5）。 */
export type JoinPolicy = "failFast" | "allSettled";

/** 创建 durable task 的选项。 */
export type TaskOptions = {
	/** 必填：task 总是声明它的归属者（spec §5.5）。 */
	readonly ownership: TaskOwnership;
	/**
	 * 默认：owner task 的 conversation，或事务绑定的 conversation；对于由 Session 提交创建、但未绑定到
	 * conversation 的 conversation-owned task 则为必填。
	 */
	readonly conversationId?: ConversationId;
	/** 仅限 conversation-owned task：排除在普通 idle 等待、conversation abort 与级联之外。 */
	readonly background?: boolean;
	/**
	 * 其创建者只在内存中等待它，重启后不会恢复，因此创建它的 Harness 消失后该选项就失去意义。
	 * 调度在更晚的 Harness 中启动时，若该 task 仍存活，会被以 `restart` 为原因标记 abort，
	 * 且该标记在其任何 owned work 重新运行之前级联到全部普通 owned work。
	 */
	readonly abandonOnRestart?: boolean;
};

/** 创建 conversation 时显式选择的归属。 */
export type ConversationOwnership = { readonly kind: "ownerless" } | { readonly kind: "task"; readonly taskId: TaskId };

/** transcript scope 的不可变身份、历史谱系与 task 归属。 */
export type ConversationRecord = {
	readonly id: ConversationId;
	/** fork 来源及其包含的父 entry，历史经由此继承。 */
	readonly parent?: {
		readonly conversationId: ConversationId;
		readonly at: EntryId;
	};
	/** 用于归属、子树 abort 和子树 idle 等待的创建者边。 */
	readonly owner?: {
		readonly conversationId: ConversationId;
		readonly taskId: TaskId;
	};
};

/** 对一个可见 entry 在 model context 中的贡献所做的不可变覆盖。 */
export type ContextEdit = {
	/** 其 model 消息被省略或替换的 entry。 */
	readonly target: EntryId;
} & (
	| {
			readonly action: "omit";
			readonly messages?: never;
	  }
	| {
			readonly action: "replace";
			/** 用来替换目标 entry 的 model 消息的消息。 */
			readonly messages: readonly Message[];
	  }
);

/** 不可变的 transcript 事件，model 视角与应用视角的负载相互分离。 */
export type EntryRecord = {
	readonly id: EntryId;
	readonly conversationId: ConversationId;
	/** 应用自定义的 entry 判别符。 */
	readonly kind: string;
	/** 进入 model context 的消息；展示或记账类 entry 没有该字段。 */
	readonly model?: readonly Message[];
	/** 由视图、扩展或记账逻辑消费的 JSON 负载。 */
	readonly data?: JsonValue;
	/** 该 entry 选中为活跃 context 起点的第一个 entry。 */
	readonly head?: EntryId;
	/** 对更早可见 entry 的仅限 context 的覆盖。 */
	readonly edits?: readonly ContextEdit[];
	/** 追加该 entry 的 task（当它由 durable work 产生时）。 */
	readonly byTaskId?: TaskId;
};

/** 在 Session 赋予身份与 task 归属前提供的 entry 内容。 */
export type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
	/** `"self"` 让活跃 context 从新分配的 entry ID 开始。 */
	readonly head?: EntryId | "self";
};

/** `data` 类型为 `D` 的 entry；`never` 表示该 kind 不携带数据。 */
export type TypedEntry<D extends JsonValue> = Omit<EntryRecord, "data"> &
	([D] extends [never] ? { readonly data?: never } : { readonly data: D });

/** 类型化 kind 的 entry 内容；token 提供 `kind`。 */
export type TypedEntryDraft<D extends JsonValue> = Omit<EntryDraft, "kind" | "data"> &
	([D] extends [never] ? { readonly data?: never } : { readonly data: D });

/** 带类型收窄守卫的类型化 entry kind。 */
export interface Entry<D extends JsonValue = never> {
	readonly kind: string;
	is(entry: EntryRecord | undefined): entry is TypedEntry<D>;
}

/** 每个 durable submission 状态共有的身份字段。 */
type SubmissionRecordBase = {
	readonly id: SubmissionId;
	readonly conversationId: ConversationId;
	/** host 提供的去重键，作用域为 conversation。 */
	readonly requestId?: string;
};

/** 一次被接纳的用户输入或被动 entry 写入的持久化生命周期。 */
export type SubmissionRecord =
	| (SubmissionRecordBase & {
			readonly type: "input";
	  } & (
				| {
						/** 已被接纳，但尚未出现在 transcript 中。 */
						readonly status: "queued";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** 已进入 transcript 并由活跃 run 持有。 */
						readonly status: "placed";
						readonly entry: EntryId;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** 已成功回答的用户输入。 */
						readonly status: "done";
						readonly entry: EntryId;
						readonly answer: EntryId;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** 不再可能收到回答的终态输入。 */
						readonly status: "unanswered";
						readonly entry?: EntryId;
						readonly answer?: never;
						readonly reason: string;
						readonly detail?: JsonValue;
				  }
			))
	| (SubmissionRecordBase & {
			readonly type: "write";
	  } & (
				| {
						/** 已被接纳，但尚未追加到 transcript。 */
						readonly status: "queued";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** 已成功追加的被动 entry。 */
						readonly status: "done";
						readonly entry: EntryId;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** 未能落位的终态被动写入。 */
						readonly status: "unanswered";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason: string;
						readonly detail?: JsonValue;
				  }
			));

/** 为 submission 暂存的终态；身份、类型与 entry 来自其当前 record。 */
export type SubmissionSettlement =
	| { readonly status: "done"; readonly answer: EntryId }
	| { readonly status: "unanswered"; readonly reason: string; readonly detail?: JsonValue };

/** 在 Session 赋予 ID 之前提供的 submission 字段。 */
export type SubmissionCreate = SubmissionRecord extends infer Record
	? Record extends SubmissionRecord
		? Omit<Record, "id">
		: never
	: never;

/** 持久化以替代运行时 `Error` 对象的 JSON 安全错误快照。 */
export type TaskOutcomeError = {
	readonly message: string;
	/** 可选的结构化诊断数据，用于检查或恢复。 */
	readonly detail?: JsonValue;
};

/** task 变为终态时记录的持久化原因与可选结果。 */
export type TaskOutcome<R> =
	| {
			readonly status: "completed";
			readonly result: R;
			readonly error?: never;
			readonly reason?: never;
	  }
	/** 由实现显式提交的预期 task 或领域失败。 */
	| {
			readonly status: "failed";
			readonly error: TaskOutcomeError;
			readonly result?: R;
			readonly reason?: never;
	  }
	/** 由 task 的 abort 协议处理的显式取消。 */
	| {
			readonly status: "aborted";
			readonly reason?: string;
			readonly result?: R;
			readonly error?: never;
	  }
	/** 因定义或迁移不可用而无法恢复的 task。 */
	| {
			readonly status: "orphaned";
			readonly reason: string;
			readonly result?: never;
			readonly error?: never;
	  }
	/** 运行时检测到的契约破坏，例如未捕获的抛错或无持久化进度。 */
	| {
			readonly status: "faulted";
			readonly error: TaskOutcomeError;
			readonly result?: never;
			readonly reason?: never;
	  };

/** 一个 task 的完整持久化执行状态。 */
export type TaskState<S, R> =
	| {
			/** 可被调度。 */
			readonly status: "pending";
			/** 执行恢复所依据的完整持久化状态。 */
			readonly checkpoint: S;
			readonly outcome?: never;
	  }
	| {
			/** 由一次内存中的 task invocation 预留。 */
			readonly status: "running";
			/** 执行恢复所依据的完整持久化状态。 */
			readonly checkpoint: S;
			readonly outcome?: never;
	  }
	| {
			/** 在 `on` 中每个 task 都终态之前无 invocation 停泊；之后从 `checkpoint` 恢复。 */
			readonly status: "waiting";
			readonly checkpoint: S;
			readonly on: readonly TaskId[];
			readonly policy: JoinPolicy;
			readonly outcome?: never;
	  }
	| {
			/** 结果已决定；一旦下方不再有存活的普通 owned work 即变终态。不再执行任何代码。 */
			readonly status: "completing";
			readonly checkpoint?: never;
			readonly outcome: TaskOutcome<R>;
	  }
	| {
			/** 已永久落定的持久化结果回执。 */
			readonly status: "terminal";
			readonly checkpoint?: never;
			readonly outcome: TaskOutcome<R>;
	  };

/** 每个 task 状态共有的身份、定义与调度字段。 */
type TaskRecordBase<I, R> = {
	readonly id: TaskId<R>;
	readonly conversationId: ConversationId;
	/** 注册的 task 定义名称。 */
	readonly kind: string;
	/** 用于迁移活跃输入与 checkpoint 的定义版本号。 */
	readonly version: number;
	/** task 存活或已终态期间保留的原始 task 输入。 */
	readonly input: I;
	/** 子 task 的归属 task；由其 conversation 拥有的 task 没有该字段。不可变。 */
	readonly owner?: TaskId;
	/** 该 conversation-owned task 是否排除在普通 idle 等待、conversation abort 与级联之外。 */
	readonly background: boolean;
	/** 在 run 模式进度提交前检查的持久化 abort mark。 */
	readonly abortRequested: boolean;
	/**
	 * 标记并非因 abort 请求而设置时的原因：`restart` 表示在重启后被放弃的 task
	 * （`TaskOptions.abandonOnRestart`）或其下属。这类 task 会等待自己的定义，而不是变成 `orphaned`。
	 * 后续的 abort 请求会清除它。
	 */
	readonly abortReason?: "restart";
	/** 由 `TaskOptions.abandonOnRestart` 设置。不可变。 */
	readonly abandonOnRestart?: true;
	/**
	 * 首次变为 `running` 的墙钟毫秒时间，由 Session 打上。等待与恢复期间保留，
	 * 因此到 `endedAt` 的时间跨度包含它们。task 首次运行之前和更早版本写入的 record 中不存在。
	 */
	readonly startedAt?: number;
	/** 变为 `terminal` 的墙钟毫秒时间，由 Session 打上；存活期间不存在。 */
	readonly endedAt?: number;
};

/** 一个 durable task 状态机的完整替换 record。 */
export type TaskRecord<I, S, R> = TaskRecordBase<I, R> &
	(
		| {
				readonly state: Extract<TaskState<S, R>, { readonly status: "pending" | "running" | "waiting" }>;
				/** task 尚能运行期间保留的小型首写者胜出值。 */
				readonly memos?: Readonly<Record<string, JsonValue>>;
		  }
		| {
				readonly state: Extract<TaskState<S, R>, { readonly status: "completing" | "terminal" }>;
				readonly memos?: never;
		  }
	);

/** 一个从创建到退役的 document 实例（incarnation）的持久化生命周期 record。 */
export type DocumentRecord = {
	/** 唯一的 instance ID；同一逻辑 document 被重建时不会复用。 */
	readonly id: DocumentId;
	/** 稳定的 document 定义 kind。 */
	readonly kind: string;
	/** family 成员键；单例 document 没有该字段。 */
	readonly key?: string;
	/** 创建该 incarnation 的提交，由 storage 打上。 */
	readonly createdAt: Seq;
	/** 退役该 incarnation 的提交；仍是当前版本时没有该字段。 */
	readonly retiredAt?: Seq;
} & (
	| {
			readonly scope: { readonly kind: "session" };
			readonly history?: never;
			readonly fork?: never;
	  }
	| ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: ConversationId } } & (
			| {
					/** 只保留当前状态。 */
					readonly history: "latest";
					/** 从当前源状态或定义初始值初始化 fork。 */
					readonly fork: "current" | "initial";
			  }
			| {
					/** 保留 as-of 读取所需的历史。 */
					readonly history: "rewindable";
					/** 在其截断点、从当前状态或从初始值初始化 fork。 */
					readonly fork: "asOf" | "current" | "initial";
			  }
	  ))
	| {
			readonly scope: { readonly kind: "task"; readonly taskId: TaskId };
			readonly history?: never;
			readonly fork?: never;
	  }
);

/** storage 创建并盖章新 `DocumentRecord` 时提供的字段。 */
export type DocumentCreate = DocumentRecord extends infer Record
	? Record extends DocumentRecord
		? Omit<Record, "createdAt" | "retiredAt">
		: never
	: never;

/** 一个有序扫描结果及其可选的续传状态。 */
export type Page<T, C> = {
	readonly items: readonly T[];
	readonly next?: C;
};

/**
 * 后端所有的 JSON 续传状态，调用方只应在同一扫描上原样往返使用。它携带扫描的排序：
 * 带 cursor 的扫描按该排序继续，并在查询中出现不同 `order` 时 reject。
 */
export type Cursor = Readonly<Record<string, JsonValue>>;

/** 扫描的 ID 排序：`ascending` 最旧在前，`descending` 最新在前。 */
export type ScanOrder = "ascending" | "descending";

/** 有序 conversation 扫描的可选过滤条件。 */
export type ConversationQuery = {
	readonly ownerConversationId?: ConversationId;
	readonly ownerTaskId?: TaskId;
	/** 默认 `ascending`；带 cursor 时为 cursor 的排序。 */
	readonly order?: ScanOrder;
};

/** 扫描一个 conversation 的感知 fork 的历史时的包含 ID 边界。 */
export type EntryQuery = {
	readonly conversationId: ConversationId;
	/** 可能返回的最旧 entry ID。 */
	readonly minEntryId?: EntryId;
	/** 可能返回的最新 entry ID。 */
	readonly maxEntryId?: EntryId;
	/** 默认 `descending`；带 cursor 时为 cursor 的排序。 */
	readonly order?: ScanOrder;
};

/** 有序扫描 durable task record 时的可选过滤条件。 */
export type TaskQuery = {
	readonly conversationId?: ConversationId;
	readonly kind?: string;
	readonly status?: TaskState<JsonValue, JsonValue>["status"];
	readonly abortRequested?: boolean;
	readonly background?: boolean;
	/** 默认 `ascending`；带 cursor 时为 cursor 的排序。 */
	readonly order?: ScanOrder;
};

/** 有序扫描 submission record 时的可选过滤条件。 */
export type SubmissionQuery = {
	readonly conversationId?: ConversationId;
	readonly status?: SubmissionRecord["status"];
	/** 默认 `ascending`；带 cursor 时为 cursor 的排序。 */
	readonly order?: ScanOrder;
};

/** 当前状态，或用于 document 归属与内容读取的某个历史提交序列。 */
export type DocumentPoint = Seq | "current";

/** 单例或某个键控 family 成员的精确逻辑身份。 */
export type DocumentAddress = {
	readonly kind: string;
	readonly scope: DocumentRecord["scope"];
	/** 缺省时选中单例；出现时选中一个 family 成员。 */
	readonly key?: string;
};

/** 在同一精确 scope、同一时间点对存活 document incarnation 的有序扫描。 */
export type DocumentQuery = {
	readonly scope: DocumentRecord["scope"];
	readonly at: DocumentPoint;
	readonly kind?: string;
};

/** 由所属 Session 选择的完整 checkpoint 或 Chord 操作批次。 */
export type DocumentContent =
	| {
			readonly version: number;
			readonly kind: "base";
			readonly value: JsonObject;
	  }
	| {
			readonly version: number;
			readonly kind: "delta";
			readonly ops: readonly Op[];
	  };

/** 复制无定义 document 时选中的精确持久化来源。 */
export type DocumentCopySource = {
	readonly id: DocumentId;
	readonly at: DocumentPoint;
};

/** 在选中时间点上具体的物化值与已存定义版本。 */
export type StoredDocument = {
	readonly record: DocumentRecord;
	readonly version: number;
	readonly value: JsonObject;
	/** 在选中的 base 之后重放以物化 `value` 的 delta 数量。 */
	readonly deltasSinceBase: number;
};

/** 一次原子存储提交中的一条 record 或 document 变更。 */
export type StorageWrite =
	| { readonly type: "conversation"; readonly value: ConversationRecord }
	| { readonly type: "entry"; readonly value: EntryRecord }
	| { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
	| { readonly type: "submission"; readonly value: SubmissionRecord }
	| {
			readonly type: "document.create";
			readonly record: DocumentCreate;
			readonly content: Extract<DocumentContent, { readonly kind: "base" }>;
	  }
	| { readonly type: "document.copy"; readonly record: DocumentCreate; readonly source: DocumentCopySource }
	| {
			readonly type: "document.change";
			readonly id: DocumentId;
			readonly content: DocumentContent;
	  }
	| { readonly type: "document.retire"; readonly id: DocumentId };

/** 已提交的 document incarnation 变更。 */
export type DocumentCommitChange =
	| {
			readonly type: "document";
			readonly record: DocumentRecord;
			/** 拥有该 document 的 conversation；task document 从其 task record 推导而来。仅 Session document 未定义。 */
			readonly conversationId: ConversationId | undefined;
			/** `value` 的定义版本号；本次提交退役该 incarnation 时不存在。 */
			readonly version: number | undefined;
			/** 精确采用的不可变 revision；本次提交退役该 incarnation 时为 `null`。 */
			readonly value: JsonObject | null;
			/** 普通 update 精确采用的操作；创建与退役时为空。 */
			readonly ops: readonly Op[];
	  }
	| {
			/** 无定义子节点初始化；消费者通过状态或 watch 获取来水合（hydrate）。 */
			readonly type: "document.copy";
			readonly record: DocumentRecord;
			readonly conversationId: ConversationId;
			readonly source: DocumentCopySource;
	  };

/** 未连同其他发布副本一起提交的完整表 record。 */
export type TableCommitChange = Extract<
	StorageWrite,
	{ readonly type: "conversation" | "entry" | "task" | "submission" }
>;

export type CommitChange = TableCommitChange | DocumentCommitChange;

/** 一次成功 Session 提交产生的全部不可变变更。变更顺序未定义。 */
export type CommitPublication = {
	readonly seq: Seq;
	readonly changes: readonly CommitChange[];
};

/**
 * 一次 Session 提交回调的事务接口。
 * 表读取与创建结果是可信的不可变值，可以与内部提交状态共享。
 */
export interface Tx {
	conversation(id: ConversationId): Promise<ConversationRecord | undefined>;
	entry(id: EntryId): Promise<EntryRecord | undefined>;
	/** entry 不存在或 kind 不同时为 undefined。 */
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Promise<TypedEntry<D> | undefined>;
	task(id: TaskId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<ConversationRecord, Cursor>>;
	scanEntries(query: EntryQuery, limit: number, cursor?: Cursor): Promise<Page<EntryRecord, Cursor>>;
	/** 该 conversation 中携带 `head` 的最新可见 entry。 */
	latestHeadMarker(conversationId: ConversationId): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;
	/** 带有 conversation 作用域请求 ID 的已提交 submission。 */
	submissionByRequest(conversationId: ConversationId, requestId: string): Promise<SubmissionRecord | undefined>;

	/** 以显式选择的归属创建 conversation。 */
	createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord>;
	/** 在一个具体可见 entry 处创建历史 fork，并显式选择归属。 */
	forkConversation(
		parentConversationId: ConversationId,
		at: EntryId,
		options: { readonly ownership: ConversationOwnership },
	): Promise<ConversationRecord>;
	/** 返回的 record 是 Session 所有的不可变值，可与提交监听器共享。 */
	appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
	/** token 提供 `kind` 并为 `data` 提供类型。 */
	appendEntry<D extends JsonValue>(
		token: Entry<D>,
		conversationId: ConversationId,
		value: TypedEntryDraft<NoInfer<D>>,
	): Promise<TypedEntry<D>>;
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: TaskOptions,
	): Promise<TaskId<R>>;
	/**
	 * 用全新 ID 创建原始 submission record。不应用任何接纳规则：没有 busy 检查、没有 inbox 排队、
	 * 也没有落位。除非调用方自行实现接纳逻辑，否则请使用 `Conversation.submit()` 或 conversation 句柄。
	 */
	createSubmission(create: SubmissionCreate): Promise<SubmissionRecord>;
	/**
	 * 结算排队中或已落位的 submission；只有已落位的输入才能被回答，且已结算的 submission 保持不变。
	 * 会针对该事务中最新的 submission record 解析，因此在表写入之后仍然有效。
	 * run task 会结算它们回答的输入。
	 */
	settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): void;
	/**
	 * 将排队的 submission 落位到 `entry`：input 变为 `placed`，write 变为 `done`。与
	 * `settleSubmission()` 一样解析。Inbox 边界会落位它选中的 submission。
	 */
	placeSubmission(id: SubmissionId, entry: EntryId): void;

	doc<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
	doc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<Draft<T>>;
	doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;

	retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Promise<void>;
	retireDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<void>;
	retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
	): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
	): Promise<void>;
}

/** 绑定到一个已提交 document incarnation 的可弃置只读 Chord 状态。 */
export type DocumentState<T extends JsonObject> = AttachedReplicatedState<Readonly<T> | null>;

/** 一个 document watch 的终态结果。 */
export type WatchEnd =
	| { readonly reason: "stopped" | "cancelled" | "session_closed" | "retired" }
	| { readonly reason: "listener_error"; readonly error: Error }
	/** Session 失败了；`error` 是导致失败的原因，通常是 storage 错误（见 `SessionFailed`）。 */
	| { readonly reason: "session_failed"; readonly error: unknown };

/** 不可变值的序列化精确帧（exact-frame）观察，带有有界的待投递队列。 */
export interface WatchHandle<T> {
	/** 启动前为获取时刻的 revision；之后为最新投递的不可变 revision。 */
	readonly value: T;
	/** 安装唯一的异步监听器。绝不内联调用它。 */
	start(listener: (value: T, ops: readonly Op[], context: Context) => Promise<void>): void;
	/** 幂等地停掉后续回调，并返回该 watch 的终态结果。 */
	stop(): Promise<WatchEnd>;
	/** watch 终止时 settle；已经在运行的回调仍归调用方所有。 */
	readonly closed: Promise<WatchEnd>;
}

export type DocumentWatch<T extends JsonObject> = WatchHandle<Readonly<T> | null>;

/** 已提交的 document 读取。 */
export type DocumentReader = Pick<Session, "snapshot" | "snapshotAsOf">;

/** Session 与后续 invocation API 共享的非创建型 document watch 获取。 */
export interface DocumentObserver {
	watchDoc<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
}

/** Session 结束的原因：`close()`，或携带其错误的某次失败 Storage 调用。 */
export type SessionEnd = { readonly reason: "closed" } | { readonly reason: "failed"; readonly error: unknown };

/** 一条 mutation line 及其 record 与被跟踪 document 的所有者。 */
export interface Session extends DocumentObserver {
	/** 在 Session mutation line 上运行一次原子事务。 */
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	/** 封锁接纳、结算已接纳的提交，然后关闭 storage。 */
	close(context: Context): Promise<void>;
	/**
	 * 在 Session 已关闭（含 Storage）后 settle：在 `close()` 之后，或在第一次失败的 Storage 调用
	 * （它会自行关闭 Session）之后。失败的 Session 会从 Storage 重新打开；没有其他需要清理的内容。
	 */
	readonly closed: Promise<SessionEnd>;
	/** 采用之后同步观察完整提交。监听器不得阻塞或调用 Session API。 */
	subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void;
	/**
	 * 在关闭开始时同步观察，包括失败的 Storage 调用关闭 Session 的情形。监听器不得
	 * 阻塞或调用 Session API。
	 */
	subscribeClose(listener: () => void): () => void;

	snapshot<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;

	documentState<T extends JsonObject>(
		token: SessionDocToken<T>,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<DocumentState<T> | undefined>;

	snapshotAsOf<T extends JsonObject>(
		token: RewindableConversationDocToken<T>,
		conversationId: ConversationId,
		at: EntryId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshotAsOf<T extends JsonObject, I extends JsonValue>(
		token: RewindableConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		at: EntryId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
}

/**
 * Session record 的原子持久化边界。
 *
 * Storage 信任所属 Session 提供语义上合法的 record、引用、谱系与状态转换。实现负责保证原子性、全局 ID
 * 归属、conversation/entry 创建的不可变性、document record 一致性以及分离值；Session 负责提交的序列化。
 *
 * 方法抛出的错误是终态的：它会直接使 Session 失败，且任何东西都不会重试，
 * 因此瞬时故障应在方法内部重试。读操作的两种错误只让该读失败：`StorageRequestError`（无效请求——未知的
 * conversation、外来或格式错误的 cursor、document 未保留的历史），不得产生任何持久化影响；
 * 以及因调用方 context 被取消而导致的 reject。`commit()` 或 `mintId()` 抛出的任何错误都是致命的。
 */
export interface Storage {
	/**
	 * 原子化持久化一个批次并返回其序列号。一旦 resolve，之后经由此 storage 的读取都能观察到它。
	 */
	commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;

	/**
	 * 从 Session 全局数字 ID 命名空间返回一个全新的 branded 候选，大于之前铸造或存储过的每个 ID，
	 * 重新打开后也成立：扫描按 ID（即创建顺序）排序，Harness 依赖这一点。
	 */
	mintId<I extends Id<string>>(): Promise<I>;

	/** 按精确 ID 查找一个 conversation。 */
	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined>;

	/** 按 ID 以 `query.order`（默认升序）扫描 conversations。 */
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>>;

	/** 按 ID 查找一条全局 entry 以及持久化它的提交序列。 */
	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	/** 只有当 entry 通过所请求 conversation 的祖先谱系可见时才查找它。 */
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;

	/**
	 * 返回带有 `head` 的最新可见 entry，位置不晚于可选的包含性截断点。
	 * 返回的 entry 就是标记本身；其 `head` 值才是该范围的实际下界。
	 */
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;

	/** 以 `query.order`（默认降序）扫描包含性可见范围，最多返回 `limit` 条 entry。 */
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;

	/** 查找一个 task 的最新完整 record。 */
	task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;

	/** 按 ID 以 `query.order`（默认升序）扫描满足全部所给过滤条件的 task record。 */
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

	/** 查找一条被接纳 submission 的最新完整 record。 */
	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined>;

	/** 按 ID 以 `query.order`（默认升序）扫描满足全部所给过滤条件的 submission。 */
	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>>;

	/** 按 conversation 作用域的 host 去重键查找 submission。 */
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined>;

	/** 解析在选中时间点占据该精确逻辑地址的 incarnation。 */
	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined>;

	/** 按 ID 在选中时间点物化一个特定 incarnation，不追踪其地址上的替代版本。 */
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;

	/** 扫描在选中时间点于一个精确 scope 内存活的 incarnation。 */
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>>;

	/** 释放后端资源；之后的所有操作都必须 reject。 */
	close(context: Context): Promise<void>;
}
