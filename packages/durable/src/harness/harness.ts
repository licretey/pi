import type { AttachedReplicatedState, Context, JsonValue } from "@earendil-works/chord";
import { withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { ResetEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { contained, SessionImpl } from "../session/session.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	ConversationId,
	ConversationOwnership,
	ConversationRecord,
	Cursor,
	EntryId,
	EntryQuery,
	EntryRecord,
	Page,
	Storage,
	SubmissionId,
	TaskId,
	TaskRecord,
	Tx,
} from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { AgentDoc, configure, createAgent, resolveAgent, resolveSettings } from "./agent.ts";
import { createCompaction } from "./compaction.ts";
import { readContext } from "./context.ts";
import { InboxDoc, withdrawQueuedInputs } from "./inbox.ts";
import { LiveDoc, settleSchedulerOutcome } from "./live.ts";
import { ProviderDoc } from "./provider.ts";
import { BUILTIN_TASKS } from "./registry.ts";
import { type InvocationBinding, TaskScheduler } from "./scheduler.ts";
import { Submissions } from "./submissions.ts";
import { type TaskGraph, TaskGraphView, type TaskGraphWatch } from "./task-graph.ts";
import type {
	Agent,
	AgentChange,
	CompactionResult,
	ContextView,
	Conversation,
	ConversationAbortOptions,
	ConversationCreateOptions,
	ConversationHandle,
	ConversationInit,
	ConversationWatch,
	HarnessInspection,
	HarnessOptions,
	Harness as HarnessType,
	RegistrySnapshot,
	SettledTask,
	Submission,
	SubmissionDraft,
	ToolRegistration,
} from "./types.ts";
import { addUsageState, UsageDoc, type UsageState } from "./usage.ts";
import { scanAll } from "./util.ts";
import { type ConversationView, ConversationViews } from "./view.ts";

const SCAN_PAGE_SIZE = 256;

type CreateTarget =
	| { readonly kind: "root" }
	| { readonly kind: "independent"; readonly ownership: ConversationOwnership }
	| {
			readonly kind: "fork";
			readonly parentId: ConversationId;
			readonly at: EntryId;
			readonly ownership: ConversationOwnership;
	  };

/** 便捷方法在创建提交及创建钩子执行后应用的设置。 */
type CreateOptions = { readonly agent?: AgentChange; readonly init?: ConversationInit };

/** Conversation 句柄使用的 Harness 私有服务。 */
type ConversationHost<Tool extends ToolRegistration> = {
	readonly harness: HarnessImpl<Tool>;
	readonly storage: Storage;
	readonly tasks: TaskScheduler;
	readonly submissions: Submissions;
	readonly views: ConversationViews;
	readonly now: () => number;
	create(target: CreateTarget, options: CreateOptions, context: Context): Promise<Conversation>;
};

class ConversationImpl<Tool extends ToolRegistration> implements Conversation {
	readonly id: ConversationId;
	readonly #host: ConversationHost<Tool>;

	constructor(id: ConversationId, host: ConversationHost<Tool>) {
		this.id = id;
		this.#host = host;
	}

	agent(context: Context): Promise<Agent> {
		return this.#host.harness.resolveAgent(this.id, undefined, context);
	}

	configure(change: AgentChange, context: Context): Promise<void> {
		return this.#host.harness.commitWith((tx) => configure(tx, this.id, change), context);
	}

	submit(submission: SubmissionDraft, context: Context): Promise<Submission> {
		return this.#host.submissions.submit(this.id, submission, context);
	}

	compact(instructions: string | undefined, context: Context): Promise<TaskId<CompactionResult>> {
		this.#host.tasks.resume();
		const input = { reason: "manual", ...(instructions === undefined ? {} : { instructions }) } as const;
		return this.#host.harness.commitWith((tx) => createCompaction(tx, this.id, input), context);
	}

	async reset(handoff: string | undefined, context: Context): Promise<void> {
		const model =
			handoff === undefined
				? {}
				: { model: [{ role: "user", content: handoff, timestamp: this.#host.now() } as const] };
		const entry = { kind: ResetEntry.kind, head: "self", ...model } as const;
		await this.#host.submissions.submit(this.id, { type: "write", entry }, context);
	}

	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
		return this.#host.harness.commitWith(change, context, { conversationId: this.id });
	}

	context(context: Context, options?: { readonly at?: EntryId }): Promise<ContextView> {
		return readContext(this.#host.harness, this.#host.storage, this.id, context, options?.at);
	}

	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		const bounded: EntryQuery = {
			conversationId: this.id,
			...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
			...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
			...(query.order === undefined ? {} : { order: query.order }),
		};
		return this.#host.harness.readOnLine(() => this.#host.storage.scanEntries(bounded, limit, cursor, context));
	}

	fork(at: EntryId, options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#host.create({ kind: "fork", parentId: this.id, at, ownership: options.ownership }, options, context);
	}

	abort(context: Context, options?: ConversationAbortOptions): Promise<void> {
		this.#host.tasks.resume();
		return this.#host.tasks.abortConversation(this.id, options?.background === true, context);
	}

	waitForIdle(context: Context): Promise<void> {
		this.#host.tasks.resume();
		return this.#host.tasks.waitForIdle(this.id, context);
	}

	viewState(context: Context): Promise<AttachedReplicatedState<ConversationView>> {
		return this.#host.views.state(this.id, context);
	}

	watch(context: Context): Promise<ConversationWatch> {
		return this.#host.views.watch(this.id, context);
	}
}

/** 扩展了对话句柄和注册表的 Session 内核。 */
class HarnessImpl<Tool extends ToolRegistration> extends SessionImpl implements HarnessType {
	readonly #options: HarnessOptions<Tool>;
	readonly #report: (error: unknown) => void;
	readonly #host: ConversationHost<Tool>;
	readonly #tasks: TaskScheduler;
	readonly #submissions: Submissions;
	readonly #taskGraph: TaskGraphView;

	constructor(rawStorage: Storage, options: HarnessOptions<Tool>, context: Context) {
		const report = safeReport(options.onReport);
		const now = safeNow(options.now, report);
		super(rawStorage, now);
		// 所有组件都通过 Session 的故障保护层读写；`rawStorage` 仅传给 `super()` 使用。
		const storage = this.storage;
		this.#options = options;
		this.#report = report;
		const settings = () => resolveSettings(options.settings);
		this.#tasks = new TaskScheduler({
			session: this,
			storage,
			registry: options.registry,
			models: options.models,
			agent: (id, snapshot, callContext) => this.resolveAgent(id, snapshot as RegistrySnapshot<Tool>, callContext),
			settings,
			env: (id, callContext) => this.buildEnv(id, callContext),
			now,
			report: this.#report,
			settleOutcome: settleSchedulerOutcome,
			withdrawInputs: withdrawQueuedInputs,
			conversation: async (id, binding, callContext) => {
				const record = await this.readOnLine(() => storage.conversation(id, callContext));
				return record === undefined ? undefined : boundConversation(id, binding, this.#submissions, this.#tasks);
			},
			context: withoutAbortSignal(context),
		});
		this.#submissions = new Submissions(this, storage, now, settings, () => this.#tasks.resume());
		this.#taskGraph = new TaskGraphView(this, storage);
		this.#host = {
			harness: this,
			storage,
			tasks: this.#tasks,
			submissions: this.#submissions,
			views: new ConversationViews(this, storage),
			now,
			create: (target, createOptions, context) => this.#create(target, createOptions, context),
		};
	}

	/** 根据 `snapshot`（或当前注册表快照）解析对话已提交的 `pi.agent`，并应用当前设置。 */
	async resolveAgent(
		id: ConversationId,
		snapshot: RegistrySnapshot<Tool> | undefined,
		context: Context,
	): Promise<Agent<Tool>> {
		const registry = snapshot ?? this.#options.registry.snapshot();
		const state = await this.snapshot(AgentDoc, id, context);
		return resolveAgent(state, registry, resolveSettings(this.#options.settings), this.#report);
	}

	/** 根据对话当前的 `cwd` 构建运行环境；未配置 `env` 选项时返回 `undefined`。 */
	async buildEnv(id: ConversationId, context: Context): Promise<ExecutionEnv | undefined> {
		const build = this.#options.env;
		if (build === undefined) return undefined;
		const cwd = (await this.snapshot(AgentDoc, id, context))?.cwd;
		return build({ conversationId: id, ...(cwd === undefined ? {} : { cwd }), read: this }, context);
	}

	/** 将仍处于 `running` 状态的任务恢复为 `pending`；这是打开 Harness 流程的一部分。 */
	openTasks(context: Context): Promise<void> {
		return this.#tasks.open(context);
	}

	resume(): void {
		this.assertUsable();
		this.#tasks.resume();
	}

	getTask<R>(id: TaskId<R>, context: Context): Promise<TaskRecord<JsonValue, JsonValue, R> | undefined> {
		return this.readOnLine(() => this.storage.task(id, context)) as Promise<
			TaskRecord<JsonValue, JsonValue, R> | undefined
		>;
	}

	inspect(context: Context): Promise<HarnessInspection> {
		return this.readOnLine(async () => {
			const { scheduling, tasks } = await this.#tasks.inspect(this.#options.registry.snapshot());
			const scan = (status: "queued" | "placed") =>
				scanAll((cursor) => this.storage.scanSubmissions({ status }, SCAN_PAGE_SIZE, cursor, context));
			const submissions = [...(await scan("queued")), ...(await scan("placed"))].sort((a, b) => a.id - b.id);
			return { scheduling, tasks, submissions };
		});
	}

	submission(id: SubmissionId, context: Context): Promise<Submission | undefined> {
		return this.#submissions.get(id, context);
	}

	abortSubmission(
		id: SubmissionId,
		context: Context,
		conversationId?: ConversationId,
	): Promise<"aborted" | "already_placed" | "settled" | "not_found"> {
		return this.#submissions.abort(id, context, conversationId);
	}

	abortTask(id: TaskId, context: Context): Promise<"marked" | "terminal"> {
		return this.#tasks.abort(id, context);
	}

	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>> {
		this.#tasks.resume();
		return this.#tasks.waitForTask(id, context) as Promise<SettledTask<R>>;
	}

	waitForIdle(context: Context): Promise<void> {
		this.#tasks.resume();
		return this.#tasks.waitForIdle(undefined, context);
	}

	/** 汇总所有对话已提交的 `pi.usage`。每个文档在各自的读取时点读取，因此总量只会增加。 */
	async usage(context: Context): Promise<UsageState> {
		const conversations = await this.readOnLine(() =>
			scanAll((cursor) => this.storage.scanConversations({}, SCAN_PAGE_SIZE, cursor, context)),
		);
		const total = UsageDoc.definition.initial();
		for (const { id } of conversations) {
			const state = await this.snapshot(UsageDoc, id, context);
			if (state !== undefined) addUsageState(total, state);
		}
		return total;
	}

	taskGraph(context: Context): Promise<AttachedReplicatedState<TaskGraph>> {
		return this.#taskGraph.state(context);
	}

	watchTaskGraph(context: Context): Promise<TaskGraphWatch> {
		return this.#taskGraph.watch(context);
	}

	root(
		context: Context,
		options?: { readonly agent?: AgentChange; readonly init?: ConversationInit },
	): Promise<Conversation> {
		return this.#create({ kind: "root" }, options ?? {}, context);
	}

	async conversation(id: ConversationId, context: Context): Promise<Conversation | undefined> {
		this.assertUsable();
		const record = await this.readOnLine(() => this.storage.conversation(id, context));
		return record === undefined ? undefined : new ConversationImpl(record.id, this.#host);
	}

	createConversation(options: ConversationCreateOptions, context: Context): Promise<Conversation> {
		return this.#create({ kind: "independent", ownership: options.ownership }, options, context);
	}

	override report(error: unknown): void {
		this.#report(error);
	}

	/** 关闭监听器执行后、Storage 关闭前，通知并等待所有任务调用结束；不写入任务结果。 */
	protected override beforeClose(): Promise<void> {
		return this.#tasks.join();
	}

	async #create(target: CreateTarget, options: CreateOptions, context: Context): Promise<Conversation> {
		this.assertUsable();
		const id = await this.commitWith(async (tx) => {
			if (target.kind === "root" && (await tx.conversation(ROOT_CONVERSATION_ID)) !== undefined) {
				return ROOT_CONVERSATION_ID;
			}
			const record =
				target.kind === "root"
					? await tx.createRootConversation()
					: target.kind === "fork"
						? await tx.forkConversation(target.parentId, target.at, { ownership: target.ownership })
						: await tx.createConversation({ ownership: target.ownership });
			if (options.agent !== undefined) await configure(tx, record.id, options.agent);
			if (options.init !== undefined) await options.init(tx, record.id);
			return record.id;
		}, context);
		return new ConversationImpl(id, this.#host);
	}

	/**
	 * 每次创建或派生对话的提交都会执行此内置创建钩子：初始化空的 `pi.live`、`pi.inbox` 和
	 * `pi.usage`，创建新的 `pi.provider`，创建该对话的 `pi.agent`（参见 `createAgent()`），
	 * 然后调用 `HarnessOptions.conversationCreated`。
	 */
	protected override async conversationCreated(tx: Transaction, record: ConversationRecord): Promise<void> {
		await tx.doc(LiveDoc, record.id);
		await tx.doc(InboxDoc, record.id);
		await tx.doc(UsageDoc, record.id);
		await tx.doc(ProviderDoc, record.id);
		await createAgent(tx, record);
		await this.#options.conversationCreated?.(tx, record);
	}
}

/** 确保 `onReport` 不会失败：它是错误处理的最后出口，因此其中抛出或拒绝的异常都会被丢弃。 */
function safeReport(onReport: ((error: unknown) => void) | undefined): (error: unknown) => void {
	return (error) =>
		contained(
			() => onReport?.(error),
			() => {},
		);
}

/**
 * 宿主时钟抛出异常时回退到 `Date.now`，避免时钟故障阻止提交。首次异常会被报告；
 * 由于每次任务变更都会读取时钟，因此后续异常不再重复报告。
 */
export function safeNow(now: (() => number) | undefined, report: (error: unknown) => void): () => number {
	if (now === undefined) return Date.now;
	let reported = false;
	return () => {
		try {
			return now();
		} catch (error) {
			// 先设置标记，避免报告处理器再次读取时钟时重复报告。
			if (!reported) {
				reported = true;
				report(error);
			}
			return Date.now();
		}
	};
}

/**
 * 绑定到调用的任务和工具句柄。每个操作（包括返回的提交对象上的操作）都会先检查调用状态，
 * 并在其信号作用域内执行；调用结束后操作会被拒绝，已接纳的工作则会继续持久执行。
 */
function boundConversation(
	id: ConversationId,
	binding: InvocationBinding,
	submissions: Submissions,
	tasks: TaskScheduler,
): ConversationHandle {
	const bind = (context: Context): Context => withAbortSignal(binding.signal, context);
	const bound = <T>(operation: (context: Context) => Promise<T>) => {
		return async (context: Context): Promise<T> => {
			binding.check();
			return operation(bind(context));
		};
	};
	return {
		id,
		submit: async (draft, context) => {
			binding.check();
			const submission = await submissions.submit(id, draft, bind(context));
			return {
				id: submission.id,
				status: bound((callContext) => submission.status(callContext)),
				wait: bound((callContext) => submission.wait(callContext)),
				abort: bound((callContext) => submission.abort(callContext)),
			};
		},
		abort: async (context, options) => {
			binding.check();
			return tasks.abortConversation(id, options?.background === true, bind(context));
		},
		waitForIdle: bound((callContext) => tasks.waitForIdle(id, callContext)),
	};
}

/** 基于单个 Session 运行的持久化智能体执行框架。 */
export type Harness = HarnessType;

export const Harness = {
	/** 在给定存储上打开 Harness。Harness 运行期间注册表仍可继续变化。 */
	async open<Tool extends ToolRegistration>(
		storage: Storage,
		options: HarnessOptions<Tool>,
		context: Context,
	): Promise<Harness> {
		context.abortSignal?.throwIfAborted();
		const snapshot = options.registry.snapshot();
		const missing = BUILTIN_TASKS.filter((task) => snapshot.task(task.definition.name) === undefined);
		if (missing.length > 0) {
			const names = missing.map((task) => task.definition.name).join(", ");
			throw new Error(`Registry lacks built-in tasks ${names}; create it with createRegistry()`);
		}
		const harness = new HarnessImpl(storage, options, context);
		try {
			await harness.openTasks(context);
		} catch (error) {
			// 可能是调用方的上下文导致打开失败：关闭时不再使用该上下文，并重新抛出打开错误。
			// Storage 关闭失败会使 Session 进入失败状态并报告错误。
			await harness.close(withoutAbortSignal(context)).catch(() => {});
			throw error;
		}
		return harness;
	},
};
