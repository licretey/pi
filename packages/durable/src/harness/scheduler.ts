import { type Context, copyJson, type JsonValue } from "@earendil-works/chord";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "../env/index.ts";
import { errorMessage } from "../errors.ts";
import type { SessionImpl } from "../session/session.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	CommitPublication,
	ConversationId,
	DocumentWatch,
	EntryId,
	EntryRecord,
	HookRunner,
	JsonObject,
	NextTaskState,
	RunningTask,
	Storage,
	TaskDefinition,
	TaskId,
	TaskOutcome,
	TaskRecord,
	TaskRuntime,
	TaskState,
} from "../types.ts";
import { agentHooks } from "./agent.ts";
import { type ContextRange, readContextFrom } from "./context.ts";
import type {
	Agent,
	AnyTask,
	ConversationHandle,
	HarnessInspection,
	RegistryReader,
	RegistrySnapshot,
	Settings,
	SettledTask,
	TaskInspection,
} from "./types.ts";
import { closedError, scanAll, Waiters } from "./util.ts";

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
/** 仍能运行代码的记录：pending、running 或 waiting。 */
type RunnableTaskRecord = Extract<
	AnyTaskRecord,
	{ readonly state: { readonly status: "pending" | "running" | "waiting" } }
>;
type Checkpoint = { readonly phase: string };
type ErasedDefinition = TaskDefinition<JsonValue, Checkpoint, JsonValue, object>;
type ErasedRuntime = TaskRuntime<JsonValue, Checkpoint, JsonValue, object>;
type ErasedRunningTask = RunningTask<JsonValue, Checkpoint, JsonValue>;

const SCAN_PAGE_SIZE = 256;
/** `setTimeout` 支持的最长延时；更长的睡眠分多步等待。 */
const MAX_TIMER_DELAY = 2_147_483_647;
const LIVE_STATUSES = ["pending", "running", "waiting", "completing"] as const;

/** 在某个 registry 快照下，pending 任务无法被预留的原因。派生而来，从不持久化。 */
type BlockedReason = "missing_task" | "task_too_old" | "migration_failed";

type Resolution =
	| { readonly kind: "ready"; readonly task: AnyTask; readonly record: RunnableTaskRecord }
	| { readonly kind: "blocked"; readonly reason: BlockedReason };

/** 能接收一条记录的定义，或为什么没有定义能；判定它时不运行任务代码。 */
type Fit =
	| { readonly task: AnyTask; readonly migrates: boolean }
	| { readonly reason: BlockedReason; readonly error?: unknown };

/** 一个任务以 run 或 abort 模式运行时的一次内存中执行。 */
type Invocation = {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly mode: "run" | "abort";
	readonly controller: AbortController;
	/** 传给各 handler 的 context；由 `controller` 取消。 */
	readonly context: Context;
	/** 通过 runtime 获取的 watch；在 invocation 结束时停止。 */
	readonly watches: Set<DocumentWatch<JsonObject>>;
	ended: boolean;
	readonly done: Promise<void>;
	readonly finish: () => void;
};

/** 为其服务的 phase handler 读取的内容：phase 的快照与任务，以及惰性解析的 agent。 */
type Phase = {
	readonly snapshot: () => RegistrySnapshot;
	readonly task: () => AnyTask;
	agent: Promise<Agent> | undefined;
};

type Reservation = {
	readonly invocation: Invocation;
	readonly task: AnyTask;
	readonly snapshot: RegistrySnapshot;
};

/** 已被报告为无法接管的替换定义，按 invocation 记。 */
type ReportedTask = { readonly task: AnyTask | undefined } | undefined;

/** 刚返回的 phase 的结果，由下一步评判。 */
type PhaseResult = { readonly checkpoint: Checkpoint; readonly failure?: { readonly error: unknown } };

/** 步骤决策：继续下一个 phase、结束 invocation，或以写入 `faulted` 的方式结束它。 */
type Decision = boolean | { readonly fault: unknown };

/** scheduler 不运行任务代码就写入的终态结果。 */
export type SchedulerOutcome = Extract<TaskOutcome<JsonValue>, { readonly status: "faulted" | "orphaned" }>;

/** conversation handle 绑定的 invocation：它的 signal，以及它结束一次即抛出的检查。 */
export type InvocationBinding = { readonly signal: AbortSignal; check(): void };

/** 任务的不可变所有权字段。 */
type TaskNode = Pick<AnyTaskRecord, "conversationId" | "owner" | "background">;

/** 沿所有权树向上走的下一站：一个 owner 任务，或一个 conversation。 */
type Up = { readonly task: TaskId } | { readonly conversation: ConversationId };

/** 向上走的一步：带其节点的 owner 任务、一个 conversation，或一条尚未加载的 owner 边。 */
type Step =
	| { readonly task: TaskId; readonly node: TaskNode }
	| { readonly conversation: ConversationId }
	| { readonly unknown: true };

/** commit 暂存的候选记录；在所有权遍历中它们覆盖已提交的记录。 */
type Overlay = {
	readonly tasks: ReadonlyMap<TaskId, AnyTaskRecord>;
	readonly edges: ReadonlyMap<ConversationId, TaskId | null>;
};

/** 普通所有权遍历的起点：一个 conversation，或所有无主的 conversation。 */
type Scope = { readonly conversation: ConversationId } | { readonly roots: true };

export type TaskSchedulerOptions = {
	readonly session: SessionImpl;
	readonly storage: Storage;
	readonly registry: RegistryReader;
	readonly models: Models;
	/** 针对某个快照解析 conversation 的 agent；runtime 每个 phase 至多调用它一次。 */
	readonly agent: (conversationId: ConversationId, snapshot: RegistrySnapshot, context: Context) => Promise<Agent>;
	/** 解析 settings；每次访问都读取。 */
	readonly settings: () => Settings;
	/** 用 `HarnessOptions.env` 构建 conversation 的环境。 */
	readonly env: (conversationId: ConversationId, context: Context) => Promise<ExecutionEnv | undefined>;
	readonly now: () => number;
	readonly report: (error: unknown) => void;
	/** Harness 清理，暂存在把一个 scheduler 自写的 outcome 变为终态的那次 commit 里。 */
	readonly settleOutcome: (tx: Transaction, record: AnyTaskRecord, outcome: SchedulerOutcome) => Promise<void>;
	/** 撤回一个 conversation 排队的输入，用于 conversation 中止与中止级联。 */
	readonly withdrawInputs: (tx: Transaction, conversationId: ConversationId) => Promise<void>;
	/** 已有 conversation 的绑定到 invocation 的 handle，供任务 runtime 与工具使用。 */
	readonly conversation: (
		id: ConversationId,
		binding: InvocationBinding,
		context: Context,
	) => Promise<ConversationHandle | undefined>;
	/** scheduler 的 commit 与 invocation 使用的 context；不携带调用方的取消。 */
	readonly context: Context;
};

/**
 * 一个 Harness 的 durable 任务 scheduler。
 *
 * `#live` 镜像所有已提交的非终态任务记录：pending、running、waiting 与 completing。同步的 commit 监听器
 * 会在 Session 线上更新它，因此在线上运行的代码从它那里读到的正是已提交的状态。
 *
 * 任务与 conversation 构成一棵所有权树（spec §5.5）：一个任务的父节点是它的 owner 任务，或它的 conversation；
 * 一个 conversation 的父节点（若有）是它的 owner 任务。沿树向上的遍历决定级联、空闲范围，以及任务的普通
 * 所辖工作是否仍在运行——后者会把该任务的 outcome 以 `completing` 状态持有，并推迟其 abort handler。
 *
 * 不变量：每个任务的状态转换都由一个回调在 Session 线上被串行化地决策并写入。这涵盖预留、标记、runtime 提交、
 * 最终化，以及每个 phase 之前的那个同步步骤——后者应用优先级规则并写入 fault 或移交。handler 与 join 在线下运行。
 * 一次 invocation 在决定其结束的那个步骤内部结束，因此它排队的 runtime commit 要么先于该决策落地，要么被拒绝。
 */
export class TaskScheduler {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #registry: RegistryReader;
	readonly #models: Models;
	readonly #agent: TaskSchedulerOptions["agent"];
	readonly #settings: TaskSchedulerOptions["settings"];
	readonly #env: TaskSchedulerOptions["env"];
	readonly #now: () => number;
	readonly #report: (error: unknown) => void;
	readonly #settleOutcome: TaskSchedulerOptions["settleOutcome"];
	readonly #withdrawInputs: TaskSchedulerOptions["withdrawInputs"];
	readonly #conversation: TaskSchedulerOptions["conversation"];
	readonly #context: Context;
	readonly #live = new Map<TaskId, AnyTaskRecord>();
	/**
	 * 每个 conversation 最近一次通过任务 runtime 读取的 context 范围：之后（由它的任何任务发起的）读取
	 * 只扫描更新的 entry。`idleSince` 是它在 Harness 时间上首次被看到空闲的时刻。派生而来，从不持久化；
	 * 在空闲超过 `settings.contextRetentionMs` 后的第一次空闲检查时被丢弃，close 时同样丢弃。
	 */
	readonly #contexts = new Map<ConversationId, { range: ContextRange; idleSince: number | undefined }>();
	/** 最早过期空闲 context 的计时器；只在计时器可以被解除引用的位置使用（见 `#scheduleExpiry`）。 */
	#expiry: { readonly at: number; readonly timer: ReturnType<typeof setTimeout> } | undefined;
	readonly #invocations = new Map<TaskId, Invocation>();
	readonly #taskWaiters = new Waiters<TaskId, SettledTask<JsonValue>>();
	/** 按 conversation 记录的空闲等待者；`undefined` 等待整个 Harness。 */
	readonly #idleWaiters = new Waiters<ConversationId | undefined, void>();
	/** 每个任务迁移失败的定义；只有 registry 解析出另一个定义后才会重试。 */
	readonly #failedMigrations = new Map<TaskId, { readonly task: AnyTask; readonly error: unknown }>();
	/** 每个已加载 conversation 的 owner 任务，`null` 表示无主。 */
	readonly #edges = new Map<ConversationId, TaskId | null>();
	/** 拥有已加载 conversation 的任务；它们进入终态后其节点仍留在 `#settled` 中。 */
	readonly #conversationOwners = new Set<TaskId>();
	/** 遍历会途经的终态任务的所有权字段。 */
	readonly #settled = new Map<TaskId, TaskNode>();
	/**
	 * 下一次 reconcile 会为 `on` 中失败任务检查的 `failFast` 等待者：打开时、它们开始等待时，
	 * 以及它们中某个任务失败时。
	 */
	readonly #failFastChecks = new Set<TaskId>();
	/**
	 * 打开时发现的前一个 Harness 留下的、带 `abandonOnRestart` 的存活任务。第一次预留扫描会以 `restart` 为原因
	 * 对它们做中止标记，因此它们自身及其之下的一切都不会再运行任何 phase。
	 */
	readonly #abandoned = new Set<TaskId>();
	#reconcileScheduled = false;
	#cascadePending = false;
	#unsubscribeRegistry: () => void = () => {};
	#enabled = false;
	#closing = false;
	#dirty = false;
	#draining = false;

	constructor(options: TaskSchedulerOptions) {
		this.#session = options.session;
		this.#storage = options.storage;
		this.#registry = options.registry;
		this.#models = options.models;
		this.#agent = options.agent;
		this.#settings = options.settings;
		this.#env = options.env;
		this.#now = options.now;
		this.#report = options.report;
		this.#settleOutcome = options.settleOutcome;
		this.#withdrawInputs = options.withdrawInputs;
		this.#conversation = options.conversation;
		this.#context = options.context;
	}

	/** 加载存活任务，并把存活的 `running` 任务改回 `pending`。不派发任何东西。 */
	async open(context: Context): Promise<void> {
		this.#session.observeCommits((publication) => this.#observe(publication));
		this.#session.subscribeClose(() => this.#seal());
		this.#unsubscribeRegistry = this.#registry.subscribe(() => this.#kick());
		await this.#session.commitWith(async (tx) => {
			// 首次写入之前读取所有表。
			const scans = [];
			for (const status of LIVE_STATUSES) {
				scans.push(await scanAll((cursor) => tx.scanTasks({ status }, SCAN_PAGE_SIZE, cursor)));
			}
			for (const records of scans) {
				for (const record of records) {
					this.#live.set(record.id, record);
					if (record.abandonOnRestart === true) this.#abandoned.add(record.id);
					if (record.state.status === "running") {
						tx.setTask(withState(record, { status: "pending", checkpoint: record.state.checkpoint }));
					}
					if (record.state.status === "waiting" && record.state.policy === "failFast") {
						this.#failFastChecks.add(record.id);
					}
				}
			}
		}, context);
		// 派生出崩溃留下的、未应用于已取消 owner 之下任务的中止标记，并最终化被持有的 outcome。
		this.#cascadePending = true;
		this.#scheduleReconcile();
	}

	/** 启用调度。幂等；close 之后 kick 不做任何事。 */
	resume(): void {
		this.#enabled = true;
		this.#kick();
	}

	/**
	 * 向每一次 invocation 发出信号并等待它们；不写入任何东西。close 会在所有 close 监听器运行完后调用它，
	 * 让任务持有的等待、watch 与流以 Session 的原因结束，而不是被它的 signal 标记为取消。
	 */
	async join(): Promise<void> {
		for (const invocation of this.#invocations.values()) invocation.controller.abort();
		await Promise.allSettled([...this.#invocations.values()].map((invocation) => invocation.done));
	}

	/**
	 * 提交中止标记；或在它所拥有的任何东西都不是活体时，把一个没有任何已注册定义能接手的任务落定为
	 * `orphaned`，然后 join 线上看到的 run invocation——commit 监听器已向它发出信号。
	 * abort invocation 在任务的普通所辖工作消失后启动。`completing` 任务只做标记。新的请求会替换 `restart` 标记，
	 * 因此重启后被遗弃、且在等它的定义的任务会被孤儿化；带 `keepRestart` 时（如 owner 自己的清理），
	 * 这样的任务保留其标记并继续等待。
	 */
	async abort(id: TaskId, context: Context, keepRestart = false): Promise<"marked" | "terminal"> {
		const marked = await this.#session.commitWith(async (tx) => {
			const current = await tx.task(id);
			if (current === undefined) throw new Error(`Task ${id} does not exist`);
			if (current.state.status === "terminal") return { result: "terminal" as const };
			const invocation = this.#invocations.get(id);
			// 带 restart 标记的任务没有 run invocation；它只是在等自己的 abort。
			if (keepRestart && current.abortReason === "restart") return { result: "marked" as const };
			if (invocation === undefined && current.state.status !== "completing") {
				await this.#loadScopes(false);
				if (!this.#ownedLive().has(id)) {
					const resolution = this.#resolve(current as RunnableTaskRecord, this.#registry.snapshot());
					if (resolution.kind === "blocked") {
						await this.#terminate(tx, current, { status: "orphaned", reason: resolution.reason });
						return { result: "marked" as const };
					}
				}
			}
			if (!current.abortRequested || current.abortReason !== undefined) tx.setTask(withAbortMark(current));
			return { result: "marked" as const, run: invocation?.mode === "run" ? invocation : undefined };
		}, context);
		// commit 监听器已向 run 发出信号；join 它。忽略自身 signal 的 run 可以活得比失败的 Session 更久，
		// 此时由后者的结束来终结这次等待。
		if (marked.run !== undefined) {
			await awaitWithContext(Promise.race([marked.run.done, this.#session.failed]), context);
		}
		return marked.result;
	}

	async waitForTask(id: TaskId, context: Context): Promise<SettledTask<JsonValue>> {
		// 在线上做检查并注册，使两者之间不会漏过任何终态发布。
		const found = await this.#session.readOnLine(async () => {
			if (this.#closing) throw closedError(this.#session);
			if (this.#live.has(id)) return { promise: this.#taskWaiters.add(id, context) };
			const record = await this.#storage.task(id, context);
			if (record === undefined) throw new Error(`Task ${id} does not exist`);
			return { promise: Promise.resolve(record as SettledTask<JsonValue>) };
		});
		return found.promise;
	}

	/**
	 * 当从该 conversation 出发的普通遍历（或从所有无主 conversation 出发的遍历）到不了任何存活的
	 * 非 background 任务时兑现。
	 */
	waitForIdle(conversationId: ConversationId | undefined, context: Context): Promise<void> {
		if (this.#closing) return Promise.reject(closedError(this.#session));
		if (this.#idle(conversationId)) return Promise.resolve();
		this.#scheduleReconcile();
		return this.#idleWaiters.add(conversationId, context);
	}

	/**
	 * `Conversation.abort()`：在一次 commit 中，撤回排队的输入，并标记从该 conversation 出发的普通遍历能到达的
	 * 每一个存活的非 background 任务；范围空闲后兑现。带 `background` 时，遍历会跨越 background 边界，
	 * 等待同样覆盖它到达的每一个任务。
	 */
	async abortConversation(conversationId: ConversationId, background: boolean, context: Context): Promise<void> {
		const reached = await this.#session.commitWith(async (tx) => {
			const queued = await this.#loadScopes(true);
			const scope = { conversation: conversationId };
			const reached: TaskId[] = [];
			for (const record of this.#live.values()) {
				if (record.background && !background) continue;
				if (this.#inScope(parentOf(record), scope, background) !== true) continue;
				reached.push(record.id);
				if (!record.abortRequested || record.abortReason !== undefined) tx.setTask(withAbortMark(record));
			}
			for (const id of queued) {
				if (this.#inScope({ conversation: id }, scope, background) === true) await this.#withdrawInputs(tx, id);
			}
			return reached;
		}, context);
		if (background) for (const id of reached) await this.waitForTask(id, context);
		await this.waitForIdle(conversationId, context);
	}

	// ─── 调度 ────────────────────────────────────────────────────────────────

	#observe(publication: CommitPublication): void {
		const updated: AnyTaskRecord[] = [];
		const failed: TaskId[] = [];
		let changed = false;
		for (const change of publication.changes) {
			if (change.type !== "task") continue;
			changed = true;
			const record = change.value;
			const previous = this.#live.get(record.id);
			if (failedOutcome(record) && (previous === undefined || !failedOutcome(previous))) failed.push(record.id);
			if (record.state.status === "terminal") {
				this.#live.delete(record.id);
				this.#failedMigrations.delete(record.id);
				this.#failFastChecks.delete(record.id);
				if (this.#conversationOwners.has(record.id)) this.#settled.set(record.id, nodeOf(record));
				this.#taskWaiters.resolve(record.id, record as SettledTask<JsonValue>);
				// 它的 owner 现在可以最终化了。
				this.#scheduleReconcile();
				continue;
			}
			if (record.abortRequested && previous?.abortRequested !== true) {
				this.#cascadePending = true;
				// 向新标记任务的 run invocation 发出信号；它的下一步会终结它。
				const invocation = this.#invocations.get(record.id);
				if (invocation?.mode === "run") invocation.controller.abort();
			}
			// 一个请求替换 `restart` 标记时，会同时升级其下工作的标记。
			if (previous?.abortReason !== undefined && record.abortReason === undefined) this.#cascadePending = true;
			const status = record.state.status;
			if (status === "completing" && previous?.state.status !== "completing") {
				if (cancellationIntent(record)) this.#cascadePending = true;
				this.#scheduleReconcile();
			}
			if (status === "waiting" && record.state.policy === "failFast" && previous?.state.status !== "waiting") {
				this.#failFastChecks.add(record.id);
				this.#scheduleReconcile();
			}
			this.#live.set(record.id, record);
			updated.push(record);
		}
		for (const id of failed) {
			for (const record of this.#live.values()) {
				const state = record.state;
				if (state.status === "waiting" && state.policy === "failFast" && state.on.includes(id)) {
					this.#failFastChecks.add(record.id);
					this.#scheduleReconcile();
				}
			}
		}
		for (const change of publication.changes) {
			if (change.type === "conversation" && !this.#edges.has(change.value.id)) {
				this.#setEdge(change.value.id, change.value.owner?.taskId ?? null);
			}
		}
		for (const change of publication.changes) {
			// 已取消 owner 之下的排队输入会被撤回，即使在其级联之后。
			if (change.type !== "submission" || change.value.status !== "queued" || change.value.type !== "input")
				continue;
			const up = { conversation: change.value.conversationId };
			if (!this.#chainKnown(up) || this.#belowCancelled(up)) this.#cascadePending = true;
		}
		for (const record of updated) {
			// 已取消 owner 之下创建的工作，即使在其级联之后，也会被中止。
			if (!this.#chainKnown(parentOf(record))) this.#scheduleReconcile();
			else if (!record.background && !record.abortRequested && this.#belowCancelled(parentOf(record))) {
				this.#cascadePending = true;
			}
		}
		// 预留或步骤发现的待处理级联，会随下一次任意类型的 commit 一起运行。
		if (this.#cascadePending) this.#scheduleReconcile();
		if (!changed) return;
		this.#settleIdle();
		this.#kick();
	}

	/**
	 * `settings.contextRetentionMs`，宿主 settings 抛错时为 0。保留的 context 只是个缓存，丢弃它们是安全的；
	 * 而这里的抛错会穿透 commit 监听器、reconcile 与过期计时器。
	 */
	#contextRetentionMs(): number {
		try {
			return this.#settings().contextRetentionMs;
		} catch (error) {
			this.#report(error);
			return 0;
		}
	}

	/** 兑现空闲等待者，并丢弃每个其 conversation 已空闲超过保留期的保留 context。 */
	#settleIdle(): void {
		for (const conversationId of this.#idleWaiters.keys()) {
			if (this.#idle(conversationId)) this.#idleWaiters.resolve(conversationId);
		}
		const now = this.#now();
		const retention = this.#contextRetentionMs();
		for (const [conversationId, kept] of this.#contexts) {
			if (kept.idleSince !== undefined && now - kept.idleSince >= retention) {
				this.#contexts.delete(conversationId);
			} else if (!this.#idle(conversationId)) {
				kept.idleSince = undefined;
			} else if (retention > 0) {
				kept.idleSince ??= now;
			} else {
				this.#contexts.delete(conversationId);
			}
		}
		this.#scheduleExpiry();
	}

	/**
	 * 在最早的空闲 context 过期时运行 `#settleIdle()`。计时器是 unreferenced 的，因此绝不会让进程保活。
	 * 在计时器无法 unreferenced 的环境（如 Cloudflare Workers）则完全不保留计时器：一个未触发的计时器可能让
	 * Durable Object 无法被驱逐，而驱逐恰恰会释放这些 context。在那里，只靠任务变化来检查过期。
	 */
	#scheduleExpiry(): void {
		const retention = this.#contextRetentionMs();
		let at: number | undefined;
		for (const kept of this.#contexts.values()) {
			if (kept.idleSince !== undefined && (at === undefined || kept.idleSince + retention < at)) {
				at = kept.idleSince + retention;
			}
		}
		if (this.#expiry !== undefined && this.#expiry.at === at) return;
		if (this.#expiry !== undefined) clearTimeout(this.#expiry.timer);
		this.#expiry = undefined;
		if (at === undefined || this.#closing) return;
		const timer = setTimeout(
			() => {
				this.#expiry = undefined;
				this.#settleIdle();
			},
			Math.min(Math.max(0, at - this.#now()), MAX_TIMER_DELAY),
		);
		const unref = (timer as { unref?: unknown }).unref;
		if (typeof unref !== "function") {
			clearTimeout(timer);
			return;
		}
		unref.call(timer);
		this.#expiry = { at, timer };
	}

	// ─── 所有权 ───────────────────────────────────────────────────────────

	#scheduleReconcile(): void {
		if (this.#reconcileScheduled || this.#closing) return;
		this.#reconcileScheduled = true;
		queueMicrotask(() => void this.#reconcile());
	}

	/**
	 * 一次 commit，落实已提交记录所蕴含的一切：带取消意图的存活 owner 之下的中止标记（spec §5.4）、
	 * `failFast` 标记（spec §5.5）、已取消 owner 之下被撤回的排队输入，以及普通所辖工作已消失的每个
	 * `completing` 任务的最终 terminal 记录。持久化记录本身就是意图，因此这一步还会修复崩溃留下的
	 * 一切未落实的状态。兑现由已加载边决定的空闲等待者。
	 */
	async #reconcile(): Promise<void> {
		this.#reconcileScheduled = false;
		const cascade = this.#cascadePending;
		this.#cascadePending = false;
		const checks = [...this.#failFastChecks];
		this.#failFastChecks.clear();
		try {
			await this.#session.commitWith(async (tx) => {
				if (this.#closing) return;
				const queued = await this.#loadScopes(cascade);
				// 来自被遗弃 owner 的级联会把它的 `restart` 原因传递下去；其他任何意图则作为请求做标记，或升级一个
				// `restart` 标记。先收集完毕，使请求在这一轮中胜过 `restart` 标记。
				const marks = new Map<TaskId, { readonly record: AnyTaskRecord; readonly reason: "restart" | undefined }>();
				const mark = (record: AnyTaskRecord, reason: "restart" | undefined): void => {
					const staged = marks.get(record.id);
					if (staged !== undefined && staged.reason === undefined) return;
					if (record.abortRequested && (record.abortReason === undefined || reason !== undefined)) return;
					marks.set(record.id, { record, reason });
				};
				// 加载边可能暴露出一个已取消的 owner，因此每一轮都重新派生标记。
				for (const record of this.#live.values()) {
					if (record.background) continue;
					const owner = this.#cancellingOwner(parentOf(record));
					if (owner === undefined) continue;
					// 只有重启后被遗弃的 owner（而非其他任何东西）会传递其原因。
					const restart = owner.abortReason === "restart" && !failedOutcome(owner);
					mark(record, restart ? "restart" : undefined);
				}
				for (const id of checks) {
					const waiter = this.#live.get(id);
					if (waiter?.state.status !== "waiting" || !(await this.#anyFailed(waiter.state.on))) continue;
					// 其余每一个存活任务都做标记：失败的那个保留自己的 outcome。
					for (const member of waiter.state.on) {
						const record = this.#live.get(member);
						if (record !== undefined && !failedOutcome(record)) mark(record, undefined);
					}
				}
				for (const { record, reason } of marks.values()) tx.setTask(withAbortMark(record, reason));
				for (const id of queued) if (this.#belowCancelled({ conversation: id })) await this.#withdrawInputs(tx, id);
				await this.#finalize(tx);
			}, this.#context);
		} catch (error) {
			// 这次 commit 不运行任何扩展代码：抛错只可能是存储失败、宿主回调出错或 bug。重跑一轮解决不了
			// 任何一个，因此让 Session 失败，由它上报。
			this.#failSession(error);
		}
		this.#settleIdle();
	}

	/** `ids` 中是否有任何一个持有或以非 `completed` 的 outcome 结束。 */
	async #anyFailed(ids: readonly TaskId[]): Promise<boolean> {
		for (const id of ids) {
			const record = this.#live.get(id) ?? (await this.#storage.task(id, this.#context));
			if (record !== undefined && failedOutcome(record)) return true;
		}
		return false;
	}

	/**
	 * 为每个不再有存活普通所辖工作的 `completing` 任务写入 terminal 记录。最终化一个可能释放它的 owner，
	 * 因此会针对 commit 的候选反复执行，直到没有变化。被持有的 scheduler outcome 在这里拿到它的
	 * Harness 清理。
	 */
	async #finalize(tx: Transaction): Promise<void> {
		for (;;) {
			const overlay = overlayOf(tx);
			const owned = this.#ownedLive(overlay);
			const done = [...this.#liveRecords(overlay)].filter(
				(record) => record.state.status === "completing" && !owned.has(record.id),
			);
			if (done.length === 0) return;
			for (const record of done) {
				const outcome = (record.state as { readonly outcome: TaskOutcome<JsonValue> }).outcome;
				tx.setTask(withState(record, { status: "terminal", outcome }));
				// 提醒：只有 scheduler 写入 `faulted` 与 `orphaned`（spec §5.4）；它们的清理等待这次 commit。
				if (outcome.status === "faulted" || outcome.status === "orphaned") {
					await this.#settleOutcome(tx, record, outcome);
				}
			}
		}
	}

	/**
	 * 在 Session 线上加载每个存活任务的 owner 链；带 `queued` 时，还加载每个有排队提交的 conversation 的
	 * owner 链；返回后者。直接读取已提交的 Storage，因此可以在 commit 回调内运行。
	 */
	async #loadScopes(queued: boolean): Promise<ConversationId[]> {
		for (const record of [...this.#live.values()]) {
			if (!this.#chainKnown(parentOf(record))) await this.#loadChain(parentOf(record));
		}
		if (!queued) return [];
		const submissions = await scanAll((cursor) =>
			this.#storage.scanSubmissions({ status: "queued" }, SCAN_PAGE_SIZE, cursor, this.#context),
		);
		const conversations = [...new Set(submissions.map((submission) => submission.conversationId))];
		for (const id of conversations) await this.#loadChain({ conversation: id });
		return conversations;
	}

	/** 从 `start` 加载 owner 边与任务节点，直到其无主的根。 */
	async #loadChain(start: Up, overlay?: Overlay): Promise<void> {
		let at: Up | undefined = start;
		while (at !== undefined) {
			if ("task" in at) {
				let node = this.#node(at.task, overlay);
				if (node === undefined) {
					const record = await this.#storage.task(at.task, this.#context);
					if (record === undefined) return;
					node = nodeOf(record);
					if (record.state.status === "terminal") this.#settled.set(record.id, node);
				}
				at = parentOf(node);
			} else {
				let edge = this.#edge(at.conversation, overlay);
				if (edge === undefined) {
					const record = await this.#storage.conversation(at.conversation, this.#context);
					edge = record?.owner?.taskId ?? null;
					this.#setEdge(at.conversation, edge);
				}
				at = edge === null ? undefined : { task: edge };
			}
		}
	}

	#setEdge(conversationId: ConversationId, owner: TaskId | null): void {
		this.#edges.set(conversationId, owner);
		if (owner !== null) this.#conversationOwners.add(owner);
	}

	/** 一个 conversation 的 owner 任务，无主时为 `null`，未加载时为 `undefined`。 */
	#edge(id: ConversationId, overlay?: Overlay): TaskId | null | undefined {
		return overlay?.edges.has(id) === true ? overlay.edges.get(id) : this.#edges.get(id);
	}

	#node(id: TaskId, overlay?: Overlay): TaskNode | undefined {
		return overlay?.tasks.get(id) ?? this.#live.get(id) ?? this.#settled.get(id);
	}

	/** 从 `start` 向上遍历：owner 任务与 conversation，止于无主的根或尚未加载的边。 */
	*#above(start: Up, overlay?: Overlay): Generator<Step> {
		let at: Up | undefined = start;
		while (at !== undefined) {
			if ("task" in at) {
				const node = this.#node(at.task, overlay);
				if (node === undefined) {
					yield { unknown: true };
					return;
				}
				yield { task: at.task, node };
				at = parentOf(node);
			} else {
				yield { conversation: at.conversation };
				const edge = this.#edge(at.conversation, overlay);
				if (edge === undefined) {
					yield { unknown: true };
					return;
				}
				at = edge === null ? undefined : { task: edge };
			}
		}
	}

	/** `start` 之上的每个 owner 是否都已加载。 */
	#chainKnown(start: Up, overlay?: Overlay): boolean {
		for (const step of this.#above(start, overlay)) if ("unknown" in step) return false;
		return true;
	}

	/** 存活记录，overlay 的候选覆盖已提交的记录；终态候选则不计入。 */
	*#liveRecords(overlay?: Overlay): Generator<AnyTaskRecord> {
		for (const record of this.#live.values()) {
			const candidate = overlay?.tasks.get(record.id) ?? record;
			if (candidate.state.status !== "terminal") yield candidate;
		}
		if (overlay === undefined) return;
		for (const record of overlay.tasks.values()) {
			if (!this.#live.has(record.id) && record.state.status !== "terminal") yield record;
		}
	}

	/**
	 * 每个有存活普通所辖工作（spec §5.5）的任务，映射到那些工作：每个存活的非 background 任务，都计入其上方
	 * 每一个 owner 任务，直到并包括第一个 background owner。owner 链必须已加载。
	 */
	#ownedLive(overlay?: Overlay): Map<TaskId, TaskId[]> {
		const owned = new Map<TaskId, TaskId[]>();
		for (const record of this.#liveRecords(overlay)) {
			if (record.background) continue;
			for (const step of this.#above(parentOf(record), overlay)) {
				if ("unknown" in step) break;
				if (!("task" in step)) continue;
				const below = owned.get(step.task);
				if (below === undefined) owned.set(step.task, [record.id]);
				else below.push(record.id);
				if (step.node.background) break;
			}
		}
		return owned;
	}

	/**
	 * 从 `scope` 出发的普通遍历能否到达 `start`：向上走到达 scope 的 conversation（`roots` 时为某个无主的
	 * conversation），且不跨越 background owner，除非 `crossBackground`。有边未加载时为 `undefined`。
	 */
	#inScope(start: Up, scope: Scope, crossBackground = false): boolean | undefined {
		for (const step of this.#above(start)) {
			if ("unknown" in step) return undefined;
			if ("conversation" in step) {
				if ("conversation" in scope && step.conversation === scope.conversation) return true;
			} else if (step.node.background && !crossBackground) {
				return false;
			}
		}
		return "roots" in scope;
	}

	/**
	 * 存活 owner 的取消意图能否到达 `start`：向上走时，先于一个没有意图的 background owner 找到带意图的
	 * owner。终态 owner 绝不级联（spec §5.4）。
	 */
	#belowCancelled(start: Up): boolean {
		return this.#cancellingOwner(start) !== undefined;
	}

	/** `start` 之上最近的、其取消意图能到达它的存活 owner（若有）；见 `#belowCancelled`。 */
	#cancellingOwner(start: Up): AnyTaskRecord | undefined {
		for (const step of this.#above(start)) {
			if ("unknown" in step) return undefined;
			if (!("task" in step)) continue;
			const live = this.#live.get(step.task);
			if (live !== undefined && cancellationIntent(live)) return live;
			if (step.node.background) return undefined;
		}
		return undefined;
	}

	/** scheduler 自身 commit 中的抛错会让 Session 失败并由它上报；close 之后则忽略。 */
	#failSession(error: unknown): void {
		if (!this.#closing) this.#session.fail(error);
	}

	/** close 监听器：一旦准入被密封、`join()` 之前、或 Session 失败时同步运行。 */
	#seal(): void {
		this.#closing = true;
		try {
			this.#unsubscribeRegistry();
		} catch (error) {
			this.#report(error);
		}
		const error = closedError(this.#session);
		this.#taskWaiters.rejectAll(error);
		this.#idleWaiters.rejectAll(error);
		this.#contexts.clear();
		if (this.#expiry !== undefined) clearTimeout(this.#expiry.timer);
		this.#expiry = undefined;
	}

	#kick(): void {
		this.#dirty = true;
		if (this.#draining || !this.#enabled || this.#closing) return;
		this.#draining = true;
		// 绝不从 commit 或 registry 监听器里同步 commit。
		queueMicrotask(() => void this.#drain());
	}

	async #drain(): Promise<void> {
		try {
			while (this.#dirty && this.#enabled && !this.#closing) {
				this.#dirty = false;
				for (const reservation of await this.#reserve()) this.#start(reservation);
			}
		} catch (error) {
			// 同 `#reconcile()`：预留 commit 不运行任何扩展代码。
			this.#failSession(error);
		} finally {
			this.#draining = false;
			// 在循环最后一次检查之后到达的唤醒仍需要它的一轮处理。
			if (this.#dirty) this.#kick();
		}
	}

	/**
	 * 在一次 commit 中预留每个符合条件的任务；把没有定义能接手的中止标记任务孤儿化——重启后被遗弃的除外。
	 * open 后的第一轮只对被遗弃任务做中止标记，以便后续各轮能看到这些标记。
	 */
	async #reserve(): Promise<Reservation[]> {
		const reservations: Reservation[] = [];
		let abandoned: TaskId[] = [];
		try {
			await this.#session.commitWith(async (tx) => {
				if (!this.#enabled || this.#closing) return;
				for (const id of this.#abandoned) {
					const record = this.#live.get(id);
					if (record !== undefined && !record.abortRequested) tx.setTask(withAbortMark(record, "restart"));
				}
				if (this.#abandoned.size > 0) {
					abandoned = [...this.#abandoned];
					return;
				}
				await this.#loadScopes(false);
				const owned = this.#ownedLive();
				// 每轮最多取一次，且仅当存在候选任务时。
				let snapshot: RegistrySnapshot | undefined;
				for (const record of [...this.#live.values()]) {
					if (this.#invocations.has(record.id) || this.#waitingOn(record, owned).length > 0) continue;
					if (record.state.status === "completing") continue;
					const runnable = record as RunnableTaskRecord;
					const mode = record.abortRequested ? "abort" : "run";
					// 带取消意图的 owner 之下的工作不运行 phase，而是等它的级联标记；把级联排上，它可能还没运行过。
					if (mode === "run" && !record.background && this.#belowCancelled(parentOf(record))) {
						this.#cascadePending = true;
						this.#scheduleReconcile();
						continue;
					}
					snapshot ??= this.#registry.snapshot();
					const resolution = this.#resolve(runnable, snapshot);
					if (resolution.kind === "blocked") {
						// 被遗弃的任务在等它的定义，以便其 abort handler 能做清理。
						if (mode === "abort" && record.abortReason === undefined) {
							await this.#terminate(tx, record, { status: "orphaned", reason: resolution.reason });
						}
						continue;
					}
					if (resolution.record !== runnable || record.state.status !== "running") {
						tx.setTask(
							withState(resolution.record, {
								status: "running",
								checkpoint: resolution.record.state.checkpoint,
							}),
						);
					}
					// 已在线上注册，因此标记与后续预留都能看到它，close 也会 join 它。
					const invocation = this.#createInvocation(record, mode);
					reservations.push({ invocation, task: resolution.task, snapshot });
				}
			}, this.#context);
		} catch (error) {
			for (const { invocation } of reservations) {
				this.#invocations.delete(invocation.taskId);
				invocation.finish();
			}
			throw error;
		}
		// 已标记，或本已标记、或已消失：处理完毕。再次预留，这次能看到那些标记。
		for (const id of abandoned) this.#abandoned.delete(id);
		if (abandoned.length > 0) this.#dirty = true;
		return reservations;
	}

	/**
	 * 一个任务在下一次 invocation 之前等待的存活任务：带中止标记时为它的存活普通所辖工作——abort 自底向上
	 * 运行——否则为某个 wait 的 `on` 中仍存活的部分。
	 */
	#waitingOn(record: AnyTaskRecord, owned: ReadonlyMap<TaskId, readonly TaskId[]>): readonly TaskId[] {
		if (record.abortRequested) return owned.get(record.id) ?? [];
		if (record.state.status !== "waiting") return [];
		return record.state.on.filter((id) => this.#live.has(id));
	}

	/** 按 kind 解析记录的定义，迁移较旧的已存版本。 */
	#resolve(record: RunnableTaskRecord, snapshot: RegistrySnapshot): Resolution {
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", reason: fit.reason };
		if (!fit.migrates) return { kind: "ready", task: fit.task, record };
		const definition = erased(fit.task);
		try {
			if (definition.migrate === undefined) throw missingMigration(record, definition);
			const migrated = definition.migrate(record.input, record.state.checkpoint, record.version);
			const state = { ...record.state, checkpoint: copyJson(migrated.checkpoint) };
			const migratedRecord = { ...record, version: definition.version, input: copyJson(migrated.input), state };
			return { kind: "ready", task: fit.task, record: migratedRecord as RunnableTaskRecord };
		} catch (error) {
			this.#failedMigrations.set(record.id, { task: fit.task, error });
			this.#report(error);
			return { kind: "blocked", reason: "migration_failed" };
		}
	}

	#fit(record: AnyTaskRecord, task: AnyTask | undefined): Fit {
		if (task === undefined) return { reason: "missing_task" };
		const version = task.definition.version;
		if (version === record.version) return { task, migrates: false };
		if (version < record.version) return { reason: "task_too_old" };
		const failed = this.#failedMigrations.get(record.id);
		if (failed?.task === task) return { reason: "migration_failed", error: failed.error };
		return { task, migrates: true };
	}

	/**
	 * 在 Session 线上读取调度状态与每个存活任务及其派生状态。不运行任务代码：尚待迁移的任务显示为带
	 * `migrates` 的 `ready`；只有 scheduler 已尝试过、或根本不可能存在的迁移才显示为失败。
	 */
	async inspect(
		snapshot: RegistrySnapshot,
	): Promise<{ scheduling: HarnessInspection["scheduling"]; tasks: TaskInspection[] }> {
		await this.#loadScopes(false);
		const owned = this.#ownedLive();
		const tasks: TaskInspection[] = [];
		for (const record of this.#live.values()) {
			tasks.push({ record, state: this.#inspectTask(record, snapshot, owned) });
		}
		const scheduling = this.#closing ? "closing" : this.#enabled ? "running" : "paused";
		return { scheduling, tasks };
	}

	#inspectTask(
		record: AnyTaskRecord,
		snapshot: RegistrySnapshot,
		owned: ReadonlyMap<TaskId, readonly TaskId[]>,
	): TaskInspection["state"] {
		if (this.#invocations.has(record.id)) return { kind: "running" };
		if (record.state.status === "completing") return { kind: "completing" };
		const on = this.#waitingOn(record, owned);
		if (on.length > 0) return { kind: "waiting", on };
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", ...fit };
		if (fit.migrates && fit.task.definition.migrate === undefined) {
			return { kind: "blocked", reason: "migration_failed", error: missingMigration(record, erased(fit.task)) };
		}
		return { kind: "ready", migrates: fit.migrates };
	}

	#createInvocation(record: AnyTaskRecord, mode: "run" | "abort"): Invocation {
		const controller = new AbortController();
		const { promise: done, resolve: finish } = Promise.withResolvers<void>();
		const invocation: Invocation = {
			taskId: record.id,
			conversationId: record.conversationId,
			mode,
			controller,
			context: withAbortSignal(controller.signal, this.#context),
			watches: new Set(),
			ended: false,
			done,
			finish: () => finish(),
		};
		this.#invocations.set(record.id, invocation);
		return invocation;
	}

	#start(reservation: Reservation): void {
		const invocation = reservation.invocation;
		void (async () => {
			try {
				if (invocation.mode === "run") await this.#run(reservation);
				else await this.#runAbort(reservation);
			} catch (error) {
				this.#report(error);
			} finally {
				this.#end(invocation);
				invocation.finish();
				this.#kick();
			}
		})();
	}

	/** 运行各 phase handler，每个之前都有一个在线上决定 invocation 是否继续的步骤。 */
	async #run(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		const state = { task: reservation.task, snapshot: reservation.snapshot, reported: undefined as ReportedTask };
		const phase: Phase = { snapshot: () => state.snapshot, task: () => state.task, agent: undefined };
		const runtime = this.#runtime(invocation, phase);
		let previous: PhaseResult | undefined;
		for (;;) {
			const current = await this.#step(invocation, (tx, current) => this.#decide(tx, current, previous, state));
			// 决策与派发之间可能发生 close 的密封。
			if (current === undefined || this.#closing) return;
			const checkpoint = current.state.checkpoint;
			// 每个 phase handler 在首次使用时重新解析其 agent。
			phase.agent = undefined;
			try {
				await erased(state.task).phases[checkpoint.phase]!(current, runtime, invocation.context);
				previous = { checkpoint };
			} catch (error) {
				previous = { checkpoint, failure: { error } };
			}
		}
	}

	/**
	 * run invocation 的优先级规则，在线上执行。规则 1（终态、`completing` 或 `waiting`）与规则 2（closing）
	 * 由 `#step` 应用。返回 invocation 是否继续进入下一个 phase。
	 */
	#decide(
		tx: Transaction,
		current: ErasedRunningTask,
		previous: PhaseResult | undefined,
		state: { task: AnyTask; snapshot: RegistrySnapshot; reported: ReportedTask },
	): Decision {
		// 3. 中止标记：结束；一旦任务的普通所辖工作消失，就启动一次新的 abort invocation。
		if (current.abortRequested) return false;
		// owner 的取消意图同样会终结它，先于级联给它做标记；随后预留会把它拦下。
		if (!current.background && this.#belowCancelled(parentOf(current))) {
			this.#cascadePending = true;
			this.#scheduleReconcile();
			return false;
		}
		if (previous === undefined) return true;
		// 4. 未捕获的错误。
		if (previous.failure !== undefined) return { fault: previous.failure.error };
		// 6. 没有持久化的进展。
		if (jsonEqual(current.state.checkpoint, previous.checkpoint)) {
			const message = `Task ${current.kind} phase ${previous.checkpoint.phase} returned without durable progress`;
			return { fault: new Error(message) };
		}
		// 5. 有进展：刷新快照；移交给能接手该任务的替换定义。
		state.snapshot = this.#registry.snapshot();
		const next = state.snapshot.task(current.kind);
		if (next !== state.task) {
			if (next !== undefined && canReserve(next, current)) {
				tx.setTask(withState(current, { status: "pending", checkpoint: current.state.checkpoint }));
				return false;
			}
			if (state.reported === undefined || state.reported.task !== next) {
				state.reported = { task: next };
				const cause = next === undefined ? "missing_task" : "incompatible_task";
				this.#report(
					new Error(`Task ${current.id} keeps running under its old ${current.kind} definition`, { cause }),
				);
			}
		}
		return true;
	}

	/** 运行一次 abort handler；规则 1、2、4 适用，且不带回 outcome 的返回按 fault 处理。 */
	async #runAbort(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		const current = this.#live.get(invocation.taskId) as ErasedRunningTask | undefined;
		if (current === undefined || this.#closing) return;
		let failure: { readonly error: unknown } | undefined;
		try {
			const phase: Phase = { snapshot: () => reservation.snapshot, task: () => reservation.task, agent: undefined };
			const runtime = this.#runtime(invocation, phase);
			await erased(reservation.task).abort(current, runtime, invocation.context);
		} catch (error) {
			failure = { error };
		}
		const message = `Abort handler of task ${invocation.taskId} returned without a terminal outcome`;
		await this.#step(invocation, () => ({ fault: failure?.error ?? new Error(message) }));
	}

	/**
	 * 在 Session 线上做一次同步决策。不再运行的任务（规则 1：终态、`completing` 或 `waiting`）或正在关闭的
	 * Harness（规则 2）都会终结 invocation 而不写入；否则 `decide` 可以暂存一次写入，并返回 invocation 是否继续。
	 * 结束发生在回调内部、fault 的 Harness 清理之前。被拒绝的步骤（如 close 之后的准入）同样终结 invocation。
	 */
	async #step(
		invocation: Invocation,
		decide: (tx: Transaction, current: ErasedRunningTask) => Decision,
	): Promise<ErasedRunningTask | undefined> {
		try {
			return await this.#session.commitWith(async (tx) => {
				const found = this.#live.get(invocation.taskId);
				const current = found?.state.status === "running" ? (found as ErasedRunningTask) : undefined;
				const decision = current !== undefined && !this.#closing ? decide(tx, current) : false;
				if (decision === true) return current;
				this.#end(invocation);
				if (decision !== false) {
					const message = errorMessage(decision.fault);
					await this.#terminate(tx, current!, { status: "faulted", error: { message } });
				}
				return undefined;
			}, this.#context);
		} catch (error) {
			// 该步骤写入 scheduler 自己的决策——fault 或 terminal 记录；否则那里的抛错会让任务继续运行，
			// 被再次预留、再次运行。
			this.#end(invocation);
			this.#failSession(error);
			return undefined;
		}
	}

	/**
	 * 写入 scheduler 决定的 outcome。任务的普通所辖工作仍存活时，它以 `completing` 持有，其 Harness 清理
	 * 等待最终 commit（spec §5.5, 规则 4）；否则即为带清理的终态。
	 */
	async #terminate(tx: Transaction, record: AnyTaskRecord, outcome: SchedulerOutcome): Promise<void> {
		await this.#loadScopes(false);
		if (this.#ownedLive(overlayOf(tx)).has(record.id)) {
			tx.setTask(withState(record, { status: "completing", outcome }));
			return;
		}
		tx.setTask(withState(record, { status: "terminal", outcome }));
		await this.#settleOutcome(tx, record, outcome);
	}

	/**
	 * 用任务所提交的内容替换运行中任务的状态。普通所辖工作仍存活时，terminal 状态以 `completing` 持有——
	 * 以 commit 的候选来评判，因此同一次 commit 在该任务之下创建的工作也计入。等待会先做校验。
	 */
	async #commitState(
		tx: Transaction,
		invocation: Invocation,
		current: ErasedRunningTask,
		next: NextTaskState<Checkpoint, JsonValue>,
	): Promise<void> {
		if (next.status === "waiting") await this.#validateWait(tx, invocation, current, next.on, next.policy);
		if (next.status === "terminal") {
			const overlay = overlayOf(tx);
			await this.#loadScopes(false);
			for (const record of overlay.tasks.values()) await this.#loadChain(parentOf(record), overlay);
			if (this.#ownedLive(overlay).has(current.id)) {
				tx.setTask(withState(current, { status: "completing", outcome: next.outcome }));
				return;
			}
		}
		tx.setTask(withState(current, next));
	}

	/**
	 * 等待指定的必须是既存任务，不能是等待者自身或其 owner——它们不可能先完成；`failFast` 只能指向等待者
	 * 自己拥有的任务。abort handler 不能等待。
	 */
	async #validateWait(
		tx: Transaction,
		invocation: Invocation,
		current: ErasedRunningTask,
		on: readonly TaskId[],
		policy: string,
	): Promise<void> {
		if (invocation.mode === "abort") throw new Error(`Abort handler of task ${current.id} cannot wait`);
		const overlay = overlayOf(tx);
		await this.#loadChain(parentOf(current));
		const owners = new Set<TaskId>();
		for (const step of this.#above(parentOf(current))) if ("task" in step) owners.add(step.task);
		for (const id of on) {
			if (id === current.id || owners.has(id)) {
				throw new Error(`Task ${current.id} cannot wait on itself or its owner ${id}`);
			}
			const member = overlay.tasks.get(id) ?? this.#live.get(id) ?? (await this.#storage.task(id, this.#context));
			if (member === undefined) throw new Error(`Task ${id} does not exist`);
			if (policy === "failFast" && member.owner !== current.id) {
				throw new Error(`Task ${current.id} can wait failFast only on tasks it owns; ${id} is not one`);
			}
		}
	}

	/** 结束一次 invocation：从此其 runtime 操作一律拒绝，其 signal 中止，其 watch 停止，其任务获得自由。 */
	#end(invocation: Invocation): void {
		if (invocation.ended) return;
		invocation.ended = true;
		if (this.#invocations.get(invocation.taskId) === invocation) this.#invocations.delete(invocation.taskId);
		for (const watch of invocation.watches) void watch.stop();
		// 绑定在该 invocation 上的未决等待（如工具的 waitForTask()）会随之拒绝。
		invocation.controller.abort(endedError(invocation));
	}

	/** 范围内没有存活的非 background 任务；owner 边尚未加载的任务按在内计。 */
	#idle(conversationId: ConversationId | undefined): boolean {
		const scope: Scope = conversationId === undefined ? { roots: true } : { conversation: conversationId };
		for (const record of this.#live.values()) {
			if (!record.background && this.#inScope(parentOf(record), scope) !== false) return false;
		}
		return true;
	}

	// ─── Invocation runtime（调用期运行时） ──────────────────────────────────

	#runtime(invocation: Invocation, phase: Phase): ErasedRuntime {
		// 每个 phase handler 至多解析一次，在首次使用时，用该 invocation 的 context；phase 内固定不变。
		const agent = (): Promise<Agent> => {
			if (invocation.ended) return Promise.reject(endedError(invocation));
			if (phase.agent === undefined) {
				phase.agent = this.#agent(invocation.conversationId, phase.snapshot(), invocation.context);
				// 停止等待的调用方不能让共享解析的失败无人观察。
				phase.agent.catch(() => {});
			}
			return phase.agent;
		};
		const hooks: HookRunner<Record<string, unknown>> = {
			each: async (name, invoke) => {
				for (const handlers of agentHooks(await agent(), phase.task().definition.name)) {
					const handler = (handlers as Record<string, unknown>)[name];
					if (typeof handler !== "function") continue;
					try {
						await invoke(handler.bind(handlers));
					} catch (error) {
						if (invocation.controller.signal.aborted) throw error;
						this.#report(error);
					}
				}
			},
		};
		const settings = this.#settings;
		return {
			taskId: invocation.taskId as TaskId<JsonValue>,
			conversationId: invocation.conversationId,
			signal: invocation.controller.signal,
			models: this.#models,
			agent: (context) =>
				invocation.ended ? Promise.reject(endedError(invocation)) : awaitWithContext(agent(), context),
			get settings() {
				return settings();
			},
			env: (context) => this.#read(invocation, () => this.#env(invocation.conversationId, context)),
			hooks: hooks as ErasedRuntime["hooks"],
			get registry() {
				return phase.snapshot();
			},
			commit: (change, context) =>
				this.#gated(
					invocation,
					async (tx, current) => {
						const next = await change(tx, current);
						if (next !== undefined) await this.#commitState(tx, invocation, current, next);
					},
					context,
				),
			memo: ((name: string, ...rest: readonly unknown[]) => {
				if (rest.length === 1) {
					return this.#read(invocation, async () => memoOf(this.#live.get(invocation.taskId), name));
				}
				const candidate = rest[0] as JsonValue;
				return this.#gated(
					invocation,
					(tx, current) => {
						const winner = memoOf(current, name);
						if (winner !== undefined) return winner;
						tx.setTask({ ...current, memos: { ...current.memos, [name]: candidate } } as AnyTaskRecord);
						return candidate;
					},
					rest[1] as Context,
				);
			}) as ErasedRuntime["memo"],
			sleep: (until, context) => this.#sleep(invocation, until, context),
			watchDoc: ((...args: readonly unknown[]) => this.#watchDoc(invocation, args)) as ErasedRuntime["watchDoc"],
			snapshot: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshot")(...args),
				)) as ErasedRuntime["snapshot"],
			snapshotAsOf: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshotAsOf")(...args),
				)) as ErasedRuntime["snapshotAsOf"],
			getTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine(() => this.#storage.task(id, context)),
				)) as ErasedRuntime["getTask"],
			waitForTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.waitForTask(id, withAbortSignal(invocation.controller.signal, context)),
				)) as ErasedRuntime["waitForTask"],
			abortOwned: (id, context) =>
				this.#read(invocation, async () => {
					const bound = withAbortSignal(invocation.controller.signal, context);
					const record = await this.#session.readOnLine(() => this.#storage.task(id, bound));
					if (record?.owner !== invocation.taskId) {
						throw new Error(`Task ${id} is not owned by task ${invocation.taskId}`);
					}
					if (record.state.status === "terminal") return;
					await this.abort(id, bound, true);
					await this.waitForTask(id, bound);
				}),
			outcomes: ((ids: readonly TaskId[], context: Context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine(async () => {
						const outcomes: TaskOutcome<JsonValue>[] = [];
						for (const id of ids) {
							const state = (await this.#storage.task(id, context))?.state;
							if (state?.status !== "terminal") throw new Error(`Task ${id} is not terminal`);
							outcomes.push(state.outcome);
						}
						return outcomes;
					}),
				)) as ErasedRuntime["outcomes"],
			conversation: (id, context) =>
				this.#read(invocation, () =>
					this.#conversation(
						id,
						{
							signal: invocation.controller.signal,
							check: () => {
								if (invocation.ended) throw endedError(invocation);
							},
						},
						context,
					),
				),
			entry: ((...args: readonly unknown[]) => {
				const [token, id, context] =
					args.length === 2
						? [undefined, args[0] as EntryId, args[1] as Context]
						: [args[0] as { readonly kind: string }, args[1] as EntryId, args[2] as Context];
				return this.#read(invocation, async () => {
					const found = await this.#session.readOnLine(() =>
						this.#storage.entry(invocation.conversationId, id, context),
					);
					const entry: EntryRecord | undefined = found?.entry;
					return token === undefined || entry?.kind === token.kind ? entry : undefined;
				});
			}) as ErasedRuntime["entry"],
			context: (conversationId, context, options) =>
				this.#read(invocation, async () => {
					const { view, range } = await readContextFrom(
						this.#session,
						this.#storage,
						conversationId,
						context,
						options?.at,
						this.#contexts.get(conversationId)?.range,
					);
					// 保留它，除非 invocation 已结束，或并发的读取已保留了更新的范围。
					const kept = this.#contexts.get(conversationId);
					if (
						range !== undefined &&
						!this.#closing &&
						!invocation.ended &&
						(kept === undefined || kept.range.bounds.tail <= range.bounds.tail)
					) {
						// 对另一个空闲 conversation 的读取会开始或延续它的保留期。
						if (!this.#idle(conversationId)) {
							this.#contexts.set(conversationId, { range, idleSince: undefined });
						} else if (this.#contextRetentionMs() > 0) {
							this.#contexts.set(conversationId, { range, idleSince: kept?.idleSince ?? this.#now() });
							this.#scheduleExpiry();
						}
					}
					return view;
				}),
			now: () => {
				if (invocation.ended) throw endedError(invocation);
				return this.#now();
			},
			report: (error) => {
				if (invocation.ended) throw endedError(invocation);
				this.#report(error);
			},
		};
	}

	/** 运行一次已提交状态读取，除非 invocation 已结束。 */
	async #read<T>(invocation: Invocation, read: () => Promise<T>): Promise<T> {
		if (invocation.ended) throw endedError(invocation);
		return read();
	}

	/** 在线上重读任务并对 invocation 做门控之后 commit。 */
	#gated<T>(
		invocation: Invocation,
		change: (tx: Transaction, current: ErasedRunningTask) => T | Promise<T>,
		context: Context,
	): Promise<T> {
		if (invocation.ended) return Promise.reject(endedError(invocation));
		return this.#session.commitWith(
			async (tx) => {
				if (invocation.ended) throw endedError(invocation);
				if (this.#closing) throw closedError(this.#session);
				const found = this.#live.get(invocation.taskId);
				if (found === undefined) throw new Error(`Task ${invocation.taskId} is terminal`);
				if (found.state.status !== "running") throw new Error(`Task ${invocation.taskId} is ${found.state.status}`);
				const current = found as ErasedRunningTask;
				if (invocation.mode === "run" && current.abortRequested) {
					throw new Error(`Task ${invocation.taskId} has a durable abort mark`);
				}
				return change(tx, current);
			},
			context,
			{ conversationId: invocation.conversationId, taskId: invocation.taskId },
		);
	}

	/** 等待 Harness 时钟到达 `until`，每过一个计时器就重查一次。 */
	async #sleep(invocation: Invocation, until: number, context: Context): Promise<void> {
		if (invocation.ended) throw endedError(invocation);
		const signals = [invocation.controller.signal];
		if (context.abortSignal !== undefined) signals.push(context.abortSignal);
		const signal = AbortSignal.any(signals);
		for (;;) {
			signal.throwIfAborted();
			const remaining = until - this.#now();
			if (remaining <= 0) return;
			await delay(Math.min(remaining, MAX_TIMER_DELAY), signal);
		}
	}

	async #watchDoc(invocation: Invocation, args: readonly unknown[]): Promise<DocumentWatch<JsonObject> | undefined> {
		if (invocation.ended) throw endedError(invocation);
		const watch = (await sessionMethod(this.#session, "watchDoc")(...args)) as DocumentWatch<JsonObject> | undefined;
		if (watch === undefined) return undefined;
		if (invocation.ended) {
			void watch.stop();
			throw endedError(invocation);
		}
		invocation.watches.add(watch);
		void watch.closed.then(() => invocation.watches.delete(watch));
		return watch;
	}
}

/** 加了中止标记的记录：遗弃用 `restart`；不带原因时为一个请求，请求会替换 `restart`。 */
function withAbortMark(record: AnyTaskRecord, reason?: "restart"): AnyTaskRecord {
	const { abortReason: _reason, ...rest } = record;
	return { ...rest, abortRequested: true, ...(reason === undefined ? {} : { abortReason: reason }) } as AnyTaskRecord;
}

/** 存活 owner 的持久化取消意图：它的中止标记，或一个非 `completed` 的被持有 outcome。 */
function cancellationIntent(record: AnyTaskRecord): boolean {
	return record.state.status !== "terminal" && (record.abortRequested || failedOutcome(record));
}

/** 该记录是否持有或以非 `completed` 的 outcome 结束。 */
function failedOutcome(record: AnyTaskRecord): boolean {
	const state = record.state;
	return (state.status === "completing" || state.status === "terminal") && state.outcome.status !== "completed";
}

function parentOf(node: TaskNode): Up {
	return node.owner !== undefined ? { task: node.owner } : { conversation: node.conversationId };
}

function nodeOf(record: AnyTaskRecord): TaskNode {
	return {
		conversationId: record.conversationId,
		...(record.owner === undefined ? {} : { owner: record.owner }),
		background: record.background,
	};
}

function overlayOf(tx: Transaction): Overlay {
	const tasks = new Map(tx.stagedTasks().map((record) => [record.id, record]));
	const edges = new Map(tx.stagedConversations().map((record) => [record.id, record.owner?.taskId ?? null]));
	return { tasks, edges };
}

/** 只取自有 memo 项；`toString` 之类的 memo 名绝不能解析到继承属性上。 */
function memoOf(record: AnyTaskRecord | undefined, name: string): JsonValue | undefined {
	const memos = record?.memos;
	return memos !== undefined && Object.hasOwn(memos, name) ? memos[name] : undefined;
}

/** 绑定后的重载 Session 方法，用于原样转发参数列表。 */
function sessionMethod(
	session: SessionImpl,
	name: "snapshot" | "snapshotAsOf" | "watchDoc",
): (...args: readonly unknown[]) => Promise<unknown> {
	return (session[name] as (...args: readonly unknown[]) => Promise<unknown>).bind(session);
}

function missingMigration(record: AnyTaskRecord, definition: ErasedDefinition): Error {
	return new Error(`Task ${record.kind} version ${definition.version} has no migration from ${record.version}`);
}

function erased(task: AnyTask): ErasedDefinition {
	return task.definition as unknown as ErasedDefinition;
}

function endedError(invocation: Invocation): Error {
	return new Error(`Task ${invocation.taskId} invocation has ended`);
}

/** 替换一条存活记录的状态；outcome 一旦决定，memo 即消失。 */
function withState(record: AnyTaskRecord, state: TaskState<JsonValue, JsonValue>): AnyTaskRecord {
	if (state.status !== "terminal" && state.status !== "completing") return { ...record, state } as AnyTaskRecord;
	const { memos: _memos, ...rest } = record;
	return { ...rest, state };
}

/** 预留时定义能否接手该任务：版本相同，或版本更新且带迁移。 */
function canReserve(task: AnyTask, record: AnyTaskRecord): boolean {
	const definition = task.definition;
	return (
		definition.version === record.version || (definition.version > record.version && definition.migrate !== undefined)
	);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** 两个 JSON 值的结构相等；对象键顺序忽略。 */
function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => jsonEqual(value, right[index]));
	}
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}
