import { type AttachedReplicatedState, type Context, type JsonValue, replicatedState } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { CommittedStateSource, CommittedWatch } from "../session/observation.ts";
import { contained, type SessionImpl } from "../session/session.ts";
import type {
	CommitPublication,
	ConversationId,
	JoinPolicy,
	Storage,
	TaskId,
	TaskOutcome,
	TaskRecord,
	WatchHandle,
} from "../types.ts";
import { closedError, scanAll } from "./util.ts";

/** 一个存活任务的持久状态，不含其检查点与结果载荷（规范 §9.5）。 */
export type TaskGraphState =
	| { readonly status: "pending" | "running"; readonly phase: string }
	| {
			readonly status: "waiting";
			readonly phase: string;
			readonly on: readonly TaskId[];
			readonly policy: JoinPolicy;
	  }
	/** 结果先扣留到其所属的普通工作排空为止。 */
	| { readonly status: "completing"; readonly outcome: TaskOutcome<JsonValue>["status"] };

export type TaskGraphNode = {
	readonly id: TaskId;
	readonly kind: string;
	readonly conversationId: ConversationId;
	/** owner 任务；conversation 拥有的任务没有此字段。 */
	readonly owner?: TaskId;
	readonly background: boolean;
	readonly abortRequested: boolean;
	readonly state: TaskGraphState;
	/** 该任务拥有的 conversation，按 ID 顺序。 */
	readonly conversations: readonly ConversationId[];
};

/** 会话中所有存活的任务（规范 §9.5）。 */
export type TaskGraph = {
	/** 所有存活任务，以其十进制 ID 为键。 */
	readonly tasks: Readonly<Record<string, TaskGraphNode>>;
};

export type TaskGraphWatch = WatchHandle<TaskGraph>;

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Observer = CommittedStateSource<TaskGraph> | CommittedWatch<TaskGraph>;
type Mount = { value: TaskGraph; readonly observers: Set<Observer> };

const LIVE_STATUSES = ["pending", "running", "waiting", "completing"] as const;
const SCAN_PAGE_SIZE = 256;

/**
 * Harness 的任务图挂载点：由第一个观察者在会话线上构建，随最后一个观察者移除。
 * 它从会话的提交发布（这些是持久的）向前推进。
 */
export class TaskGraphView {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	#mount: Mount | undefined;
	#closed = false;

	constructor(session: SessionImpl, storage: Storage) {
		this.#session = session;
		this.#storage = storage;
		session.observeCommits((publication, context) => {
			if (this.#mount !== undefined) advance(this.#mount, publication, context, (error) => session.report(error));
		});
		session.subscribeClose(() => {
			this.#closed = true;
			for (const observer of [...(this.#mount?.observers ?? [])]) {
				contained(
					() => observer.closeSession(this.#session.failure),
					(error) => session.report(error),
				);
			}
			this.#mount = undefined;
		});
	}

	/** 图的一次性只读 Chord 状态。 */
	async state(context: Context): Promise<AttachedReplicatedState<TaskGraph>> {
		const { observer, detach } = await this.#attach(
			(value, release) => new CommittedStateSource<TaskGraph>(value, release),
			context,
		);
		try {
			return replicatedState(observer, { onError: (error) => this.#session.report(error) });
		} catch (error) {
			detach();
			throw error;
		}
	}

	/** 图的序列化精确帧监视；取消 `context` 即停止。 */
	async watch(context: Context): Promise<TaskGraphWatch> {
		const { observer } = await this.#attach(
			(value, release) => new CommittedWatch<TaskGraph>(value, release, (error) => this.#session.report(error)),
			context,
		);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			observer.cancel();
			throw signal.reason;
		}
		if (signal !== undefined) observer.observeCancellation(signal);
		return observer;
	}

	/** 在会话线上原子地注册一个从当前版本创建的观察者。 */
	#attach<O extends Observer>(
		create: (value: TaskGraph, release: () => void) => O,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		return this.#session.readOnLine(async () => {
			const mount = this.#mount ?? { value: await this.#build(context), observers: new Set<Observer>() };
			const detach = (): void => {
				mount.observers.delete(observer);
				if (mount.observers.size === 0 && this.#mount === mount) this.#mount = undefined;
			};
			const observer = create(mount.value, detach);
			// mount 构建期间可能开始 close 或取消；此时不注册任何东西。
			if (this.#closed) throw closedError(this.#session);
			context.abortSignal?.throwIfAborted();
			this.#mount = mount;
			mount.observers.add(observer);
			return { observer, detach };
		});
	}

	async #build(context: Context): Promise<TaskGraph> {
		const tasks: Record<string, TaskGraphNode> = {};
		const records: AnyTaskRecord[] = [];
		for (const status of LIVE_STATUSES) {
			records.push(
				...(await scanAll((cursor) => this.#storage.scanTasks({ status }, SCAN_PAGE_SIZE, cursor, context))),
			);
		}
		records.sort((a, b) => a.id - b.id);
		for (const record of records) {
			const owned = await scanAll((cursor) =>
				this.#storage.scanConversations({ ownerTaskId: record.id }, SCAN_PAGE_SIZE, cursor, context),
			);
			const conversations = owned.map((conversation) => conversation.id).sort((a, b) => a - b);
			tasks[String(record.id)] = nodeOf(record, conversations);
		}
		return { tasks };
	}
}

/**
 * 从一次发布推导出挂载点的操作，应用它们，并把新版本交给每个观察者；抛错者经 `report` 上报，
 * 其余观察者照常收到。
 */
function advance(
	mount: Mount,
	publication: CommitPublication,
	context: Context,
	report: (error: unknown) => void,
): void {
	const ops: Op[] = [];
	// 本次发布设置或删除的节点，叠加在 mount 的取值之上。
	const changed = new Map<string, TaskGraphNode | undefined>();
	const node = (key: string): TaskGraphNode | undefined =>
		changed.has(key) ? changed.get(key) : mount.value.tasks[key];
	for (const change of publication.changes) {
		if (change.type !== "task") continue;
		const record = change.value;
		const key = String(record.id);
		const previous = node(key);
		if (record.state.status === "terminal") {
			if (previous === undefined) continue;
			ops.push(["d", ["tasks", key]]);
			changed.set(key, undefined);
			continue;
		}
		const next = nodeOf(record, previous?.conversations ?? []);
		if (previous !== undefined && JSON.stringify(next) === JSON.stringify(previous)) continue;
		ops.push(["s", ["tasks", key], next as unknown as JsonValue]);
		changed.set(key, next);
	}
	// 放在任务之后处理：同一提交中随属主任务一起创建的对话才能找到属主节点。发布内部的变更顺序并无保证，
	// 因此每个属主的列表都要再次排序。
	const created = new Map<string, ConversationId[]>();
	for (const change of publication.changes) {
		if (change.type !== "conversation" || change.value.owner === undefined) continue;
		const key = String(change.value.owner.taskId);
		if (node(key) !== undefined) created.set(key, [...(created.get(key) ?? []), change.value.id]);
	}
	for (const [key, ids] of created) {
		const conversations = [...node(key)!.conversations, ...ids].sort((a, b) => a - b);
		ops.push(["s", ["tasks", key, "conversations"], conversations]);
	}
	if (ops.length === 0) return;
	mount.value = applyImmutable(mount.value, ops);
	const frameContext = withoutAbortSignal(context);
	for (const observer of [...mount.observers])
		contained(() => observer.advance(mount.value, ops, frameContext), report);
}

function nodeOf(record: AnyTaskRecord, conversations: readonly ConversationId[]): TaskGraphNode {
	return {
		id: record.id,
		kind: record.kind,
		conversationId: record.conversationId,
		...(record.owner === undefined ? {} : { owner: record.owner }),
		background: record.background,
		abortRequested: record.abortRequested,
		state: stateOf(record),
		conversations,
	};
}

function stateOf(record: AnyTaskRecord): TaskGraphState {
	const state = record.state;
	switch (state.status) {
		case "pending":
		case "running":
			return { status: state.status, phase: phaseOf(state.checkpoint) };
		case "waiting":
			return { status: "waiting", phase: phaseOf(state.checkpoint), on: [...state.on], policy: state.policy };
		// 终态记录不会走到这里：它们已离开任务图。
		case "completing":
		case "terminal":
			return { status: "completing", outcome: state.outcome.status };
	}
}

function phaseOf(checkpoint: JsonValue): string {
	return (checkpoint as { readonly phase: string }).phase;
}
