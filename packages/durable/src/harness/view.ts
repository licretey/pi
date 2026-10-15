import { type AttachedReplicatedState, type Context, type JsonValue, replicatedState } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { applyImmutable, type NonEmptyPath, type Op, type Path } from "@earendil-works/chord/delta";
import { CommittedStateSource, CommittedWatch } from "../session/observation.ts";
import { contained, type SessionImpl } from "../session/session.ts";
import type {
	CommitPublication,
	ConversationDocToken,
	ConversationId,
	ConversationRecord,
	DocumentId,
	EntryRecord,
	JsonObject,
	Storage,
	WatchHandle,
} from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { activeEntries, captureContextBounds } from "./context.ts";
import { InboxDoc } from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { ProviderDoc } from "./provider.ts";
import { UsageDoc } from "./usage.ts";
import { closedError } from "./util.ts";

/** 单个对话的活动记录和内置文档的结构化挂载（规范 §9.3）。 */
export type ConversationView = {
	readonly conversation: ConversationRecord;
	/** 原始活动条目，与 `ContextView.entries` 一致：先放头部标记，再放该头部包含的非头部条目。 */
	readonly entries: readonly EntryRecord[];
	/** 按类型索引的内置对话文档；不存在的文档不会出现在此处。 */
	readonly docs: Readonly<Record<string, JsonObject>>;
};

/** 接收挂载的每个后续版本，以及 Session 关闭通知。 */
export type ViewObserver = {
	advance?(value: ConversationView, ops: readonly Op[], context: Context): void;
	/** 挂载处理每次发布后触发；`ops` 是挂载自身的操作，也可能为空。 */
	publication?(
		before: ConversationView,
		after: ConversationView,
		ops: readonly Op[],
		publication: CommitPublication,
		context: Context,
	): void;
	closeSession(failure: { readonly error: unknown } | undefined): void;
};

const MOUNTED = [
	AgentDoc,
	LiveDoc,
	InboxDoc,
	ProviderDoc,
	UsageDoc,
] as unknown as readonly ConversationDocToken<JsonObject>[];
const MOUNTED_KINDS: ReadonlySet<string> = new Set(MOUNTED.map((token) => token.definition.kind));

/** 单个对话的挂载：当前版本、所展示的文档实例及其观察者。 */
type Mount = {
	value: ConversationView;
	/** 每种文档已挂载的实例及定义版本；实例或版本变化时会整体设置文档。 */
	readonly docs: Map<string, { id: DocumentId; version: number }>;
	readonly observers: Set<ViewObserver>;
};

const VIEWS = new WeakMap<object, ConversationViews>();

/** Harness 的视图挂载集合，供基于这些挂载构建的适配器使用。 */
export function conversationViews(harness: object): ConversationViews {
	const views = VIEWS.get(harness);
	if (views === undefined) throw new Error("Not a Harness");
	return views;
}

/**
 * Harness 的对话视图挂载集合：每个对话最多挂载一次，由首个观察者在 Session 顺序线上创建，并在最后一个观察者离开时移除。
 * 每个挂载都根据 Session 的提交发布推进；这些发布具有持久性。
 */
export class ConversationViews {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #mounts = new Map<ConversationId, Mount>();
	#closed = false;

	constructor(session: SessionImpl, storage: Storage) {
		this.#session = session;
		this.#storage = storage;
		VIEWS.set(session, this);
		session.observeCommits((publication, context) => {
			for (const [id, mount] of this.#mounts)
				advance(id, mount, publication, context, (error) => this.report(error));
		});
		session.subscribeClose(() => {
			this.#closed = true;
			for (const mount of this.#mounts.values())
				for (const observer of [...mount.observers]) {
					contained(
						() => observer.closeSession(this.#session.failure),
						(error) => this.report(error),
					);
				}
			this.#mounts.clear();
		});
	}

	/** 通过 Harness 上报观察者监听器中的错误。 */
	report(error: unknown): void {
		this.#session.report(error);
	}

	/** 视图的只读 Chord 状态；释放后不再观察更新。 */
	async state(id: ConversationId, context: Context): Promise<AttachedReplicatedState<ConversationView>> {
		const { observer, detach } = await this.attach(
			id,
			(value, release) => new CommittedStateSource<ConversationView>(value, release),
			context,
		);
		try {
			return replicatedState(observer, { onError: (error) => this.#session.report(error) });
		} catch (error) {
			detach();
			throw error;
		}
	}

	/** 按帧串行观察视图；取消 `context` 会停止观察。 */
	async watch(id: ConversationId, context: Context): Promise<WatchHandle<ConversationView>> {
		const { observer } = await this.attach(
			id,
			(value, release) =>
				new CommittedWatch<ConversationView>(value, release, (error) => this.#session.report(error)),
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

	/**
	 * 在 Session 顺序线上，以原子方式注册基于当前版本创建的观察者：它能看到之后的每次
	 * 发布，而看不到此前的发布。`create` 可在线读取已提交的 Storage。`release` 会移除观察者，并在
	 * 最后一个观察者离开时卸载视图。
	 */
	attach<O extends ViewObserver>(
		id: ConversationId,
		create: (value: ConversationView, release: () => void, storage: Storage) => O | Promise<O>,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		return this.#session.readOnLine(async () => {
			const mount = this.#mounts.get(id) ?? (await this.#build(id, context));
			const detach = (): void => {
				mount.observers.delete(observer);
				if (mount.observers.size === 0 && this.#mounts.get(id) === mount) this.#mounts.delete(id);
			};
			const observer = await create(mount.value, detach, this.#storage);
			// 挂载加载期间可能开始关闭或取消；此时不要注册观察者。
			if (this.#closed) throw closedError(this.#session);
			context.abortSignal?.throwIfAborted();
			this.#mounts.set(id, mount);
			mount.observers.add(observer);
			return { observer, detach };
		});
	}

	async #build(id: ConversationId, context: Context): Promise<Mount> {
		const conversation = await this.#storage.conversation(id, context);
		if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
		const bounds = await captureContextBounds(this.#storage, id, context);
		const entries = await activeEntries(this.#storage, id, bounds, context);
		const docs: Record<string, JsonObject> = {};
		const incarnations = new Map<string, { id: DocumentId; version: number }>();
		for (const token of MOUNTED) {
			const loaded = await this.#session.conversationDocumentOnLine(token, id, context);
			if (loaded === undefined) continue;
			docs[token.definition.kind] = loaded.value;
			incarnations.set(token.definition.kind, { id: loaded.record.id, version: loaded.version });
		}
		return { value: { conversation, entries, docs }, docs: incarnations, observers: new Set() };
	}
}

/**
 * 根据一次发布推导挂载操作并应用，然后将新版本交给所有观察者；某个观察者
 * 抛出异常时通过 `report` 上报，其他观察者仍会收到该版本。
 */
function advance(
	id: ConversationId,
	mount: Mount,
	publication: CommitPublication,
	context: Context,
	report: (error: unknown) => void,
): void {
	const docOps: Op[] = [];
	const entryOps: Op[] = [];
	let entries = mount.value.entries;
	// 条目写入按 ID 顺序发布。
	for (const change of publication.changes) {
		if (change.type === "entry" && change.value.conversationId === id) {
			const entry = change.value;
			const value = entry as unknown as JsonValue;
			if (entry.head === undefined) {
				entryOps.push(["p", ["entries"], entries.length, 0, [value]]);
				entries = [...entries, entry];
				continue;
			}
			// 头部标记会保留其头部对应的非头部条目；这些条目始终构成后缀，标记本身放在最前面。
			const target = entry.head;
			let kept = entries.findIndex((candidate) => candidate.head === undefined && candidate.id >= target);
			if (kept < 0) kept = entries.length;
			entryOps.push(["p", ["entries"], 0, kept, [value]]);
			entries = [entry, ...entries.slice(kept)];
			continue;
		}
		if (change.type !== "document" || change.conversationId !== id) continue;
		const kind = change.record.kind;
		if (!MOUNTED_KINDS.has(kind) || change.record.key !== undefined) continue;
		const path: NonEmptyPath = ["docs", kind];
		const mounted = mount.docs.get(kind);
		if (change.value === null) {
			if (mounted?.id !== change.record.id) continue;
			mount.docs.delete(kind);
			docOps.push(["d", path]);
		} else if (mounted?.id === change.record.id && mounted.version === change.version) {
			for (const op of change.ops) docOps.push(prefixed(op, path));
		} else {
			mount.docs.set(kind, { id: change.record.id, version: change.version! });
			docOps.push(["s", path, change.value]);
		}
	}
	const before = mount.value;
	const ops = [...docOps, ...entryOps];
	const frameContext = withoutAbortSignal(context);
	if (ops.length > 0) {
		const value = docOps.length === 0 ? mount.value : applyImmutable(mount.value, docOps);
		mount.value = entries === value.entries ? value : { ...value, entries };
		for (const observer of [...mount.observers]) {
			contained(() => observer.advance?.(mount.value, ops, frameContext), report);
		}
	}
	for (const observer of [...mount.observers]) {
		contained(() => observer.publication?.(before, mount.value, ops, publication, frameContext), report);
	}
}

/** 将 `op` 移到 `prefix` 之下；根节点替换会转换为对该前缀的设置操作。 */
function prefixed(op: Op, prefix: NonEmptyPath): Op {
	const at = (path: Path): NonEmptyPath => [...prefix, ...path] as unknown as NonEmptyPath;
	switch (op[0]) {
		case "r":
			return ["s", prefix, op[1]];
		case "p":
			return ["p", at(op[1]), op[2], op[3], op[4]];
		case "m":
			return ["m", at(op[1]), op[2]];
		case "s":
			return ["s", at(op[1]), op[2]];
		case "d":
			return ["d", at(op[1])];
		case "a":
			return ["a", at(op[1]), op[2]];
		case "t":
			return ["t", at(op[1]), op[2]];
	}
}
