import { type Context, copyJson, type Draft, type JsonValue } from "@earendil-works/chord";
import { type Change, type Op, type Prepared, type Tracker, track } from "@earendil-works/chord/delta";
import {
	type AnyDocDefinition,
	type AnyDocToken,
	addressId,
	checkRecordScope,
	checkRecordVersion,
	documentCreate,
	materializeDocumentValue,
	type ResolvedAddress,
	resolveAddress,
} from "../documents.ts";
import { ReadAfterWrite } from "../errors.ts";
import type {
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	ConversationOwnership,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentCommitChange,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	Entry,
	EntryDraft,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Seq,
	SessionDocFamilyToken,
	SessionDocToken,
	Storage,
	StorageWrite,
	SubmissionCreate,
	SubmissionId,
	SubmissionRecord,
	SubmissionSettlement,
	Task,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	TaskOptions,
	TaskQuery,
	TaskRecord,
	Tx,
	TypedEntry,
	TypedEntryDraft,
} from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { prepareForkDocumentCopies } from "./forks.ts";

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** 暂存的提交变更：一次结算（settlement），或将排队提交放置到其条目上。 */
type SubmissionChange = SubmissionSettlement | { readonly status: "placed"; readonly entry: EntryId };

/**
 * 应用一次变更后的完整记录。放置操作使排队的输入变为 `placed`、排队的写入变为 `done`；只有已放置的输入才能被
 * 回答。已结算的记录保持不变。
 */
function applySubmissionChange(current: SubmissionRecord, change: SubmissionChange): SubmissionRecord {
	if (current.status === "done" || current.status === "unanswered") return current;
	if (change.status === "placed") {
		if (current.status !== "queued") throw new Error(`Submission ${current.id} is not queued`);
		const status = current.type === "input" ? "placed" : "done";
		return { ...current, status, entry: change.entry } as SubmissionRecord;
	}
	if (change.status === "done" && current.status !== "placed") {
		throw new Error(`Submission ${current.id} is not a placed input`);
	}
	// 排队和已放置的记录不携带 answer、reason 或 detail；未回答的输入保留其条目。
	return { ...current, ...change } as SubmissionRecord;
}

const INTERNAL_SCAN_PAGE_SIZE = 256;
const EMPTY_OPERATIONS: readonly Op[] = [];
const TABLE_JSON_COPY_OPTIONS = { omitUndefinedProperties: true } as const;

/** Session 跟踪器缓存拥有的一个已提交文档化身（incarnation）。 */
export type LoadedDocument = {
	readonly addressId: string;
	readonly record: DocumentRecord;
	/** 已持久化的定义版本；当被跟踪的值仅在内存中迁移时，该值保持较旧。 */
	storedVersion: number;
	/** 被跟踪的值当前所处形态对应的定义版本；以其他版本访问会从存储重新加载。 */
	readonly valueVersion: number;
	/** 最新基线（base）之后已存储的增量数；由 adoption 推进，使下一次谓词调用无需读取。 */
	deltasSinceBase: number;
	readonly tracker: Tracker<JsonObject>;
};

/** 事务在持有变更线（mutation line）期间使用的 Session 服务。 */
export interface TransactionHost {
	readonly storage: Storage;
	/** 用于任务生命周期时间的墙钟。 */
	now(): number;
	/** 返回缓存中的当前化身，不做加载。 */
	cached(addressId: string): LoadedDocument | undefined;
	/** 返回缓存中的当前化身，必要时进行冷加载并迁移。 */
	load(
		definition: AnyDocDefinition,
		addressId: string,
		address: DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined>;
	/** 安装一个新提交的化身。 */
	install(document: LoadedDocument): void;
	/** 若某地址在缓存中仍由该化身占据，则移除这个已退役（retired）的化身。 */
	evict(addressId: string, recordId: DocumentId): void;
	/** 在创建事务中，为每个新建或分叉的会话暂存其专属的写入。 */
	conversationCreated(tx: Transaction, record: ConversationRecord): Promise<void>;
}

/** 本事务触及的每个任务的已提交状态与候选状态。 */
type TransactionTask = {
	committedRead?: Promise<AnyTaskRecord | undefined>;
	write?: { readonly kind: "create" | "replace"; readonly record: AnyTaskRecord };
	publicationConversationId?: ConversationId;
};

/** 提交绑定的默认值：`tx.createTask()` 的会话，以及追加条目归属的任务。 */
export type TransactionScope = {
	readonly conversationId?: ConversationId;
	/** 本次提交所属任务运行时的 ID；会以 `byTaskId` 戳记在追加的条目上。 */
	readonly taskId?: TaskId;
};

/** 一个暂存文档化身的来源（存储或缓存）。 */
type DocumentTarget =
	| { readonly kind: "loaded"; readonly document: LoadedDocument }
	| {
			readonly kind: "created";
			readonly record: DocumentCreate;
			readonly version: number;
			readonly tracker: Tracker<JsonObject>;
	  }
	| {
			readonly kind: "fork-copy";
			readonly record: DocumentCreate;
			readonly source: DocumentCopySource;
	  }
	| { readonly kind: "retire-only"; readonly record: DocumentRecord };

/** 本事务获取、创建或退役的一个文档化身。 */
type DocumentEntry = {
	readonly addressId: string;
	readonly address: DocumentAddress;
	/** 无定义的分叉副本与终端任务扫描发现的退役条目没有此字段。 */
	definition?: AnyDocDefinition;
	/** 已记忆化的公开获取（acquisition）；仅元数据的退役没有此字段。 */
	draftPromise?: Promise<Draft<JsonObject>>;
	/** 获取或退役查找找到受影响的化身之后设置。 */
	target?: DocumentTarget;
	change?: Change<JsonObject>;
	prepared?: Prepared<JsonObject>;
	retireOnCommit: boolean;
};

/**
 * 一个暂存化身要写入与发布的内容，在写入存储之前一次性确定，adoption 只负责落实。
 * `record` 对已提交的化身是 `DocumentRecord`，对新化身是 `DocumentCreate`。
 */
type DocumentPlan = {
	readonly addressId: string;
	readonly record: DocumentCreate | DocumentRecord;
	retire: boolean;
	/** 创建、复制或变更的内容；仅写退役时没有此字段。 */
	content?: Extract<StorageWrite, { readonly type: "document.create" | "document.copy" | "document.change" }>;
	/** 被跟踪化身的已准备（prepared）变更；分叉副本与仅退役条目没有此字段。 */
	readonly change?: {
		readonly tracker: Tracker<JsonObject>;
		readonly prepared: Prepared<JsonObject>;
		readonly version: number;
		/** 此变更所更新的缓存化身；创建新化身时没有此字段。 */
		readonly loaded?: LoadedDocument;
		readonly definition?: AnyDocDefinition;
	};
	/** 在写入存储之前解析，使 adoption 不执行任何读取。 */
	conversationId?: ConversationId;
};

/**
 * 一个 Session 提交回调对应的事务。
 *
 * 每个异步操作都会被跟踪，以便回调落定时能拒绝并清空未完成的工作。Session 调用一个落定方法，随后要么丢弃
 * 已准备的变更，要么在存储成功后一次性采纳它们。
 */
export class Transaction implements Tx {
	readonly #host: TransactionHost;
	readonly #context: Context;
	readonly #scope: TransactionScope;
	readonly #pendingOperations = new Set<Promise<unknown>>();
	#sealed = false;
	#hasTableWrite = false;

	/** 原子批次；会话与条目写入即刻暂存，任务与文档写入在组装阶段才生成。 */
	readonly #writes: StorageWrite[] = [];
	readonly #createdConversationIds = new Set<ConversationId>();
	readonly #forkSourceConversationIds = new Set<ConversationId>();
	readonly #forkSourceDocumentIds = new Set<DocumentId>();
	/** 每个被公开读取、候选写入或文档所有者查找触及的任务对应一个条目。 */
	readonly #tasksById = new Map<TaskId, TransactionTask>();
	/** 本事务创建的提交，按 ID 索引。 */
	readonly #submissions = new Map<SubmissionId, SubmissionRecord>();
	/** 按暂存顺序记录的提交结算与放置；组装期间针对最新候选记录解析。 */
	readonly #submissionChanges: { readonly id: SubmissionId; readonly change: SubmissionChange }[] = [];

	/** 每个暂存化身的写入与发布计划，在组装期间构建。 */
	readonly #plans: DocumentPlan[] = [];
	/** 按暂存顺序记录的每一次文档获取或退役标记。 */
	readonly #documents: DocumentEntry[] = [];
	/** 每个逻辑地址上最新的本事务局部化身或退役标记。 */
	readonly #latestDocumentByAddress = new Map<string, DocumentEntry>();

	constructor(host: TransactionHost, context: Context, scope: TransactionScope = {}) {
		this.#host = host;
		this.#context = context;
		this.#scope = scope;
	}

	// ─── 表读取 ────────────────────────────────────────────────────────

	conversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		return this.#read("conversation", () => this.#host.storage.conversation(id, this.#context));
	}

	entry(id: EntryId): Promise<EntryRecord | undefined>;
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Promise<TypedEntry<D> | undefined>;
	entry(first: EntryId | { readonly kind: string }, second?: EntryId): Promise<EntryRecord | undefined> {
		const kind = typeof first === "number" ? undefined : first.kind;
		const id = typeof first === "number" ? first : second!;
		return this.#read("entry", async () => {
			const entry = (await this.#host.storage.entry(id, this.#context))?.entry;
			return kind === undefined || entry?.kind === kind ? entry : undefined;
		});
	}

	task(id: TaskId): Promise<AnyTaskRecord | undefined> {
		return this.#read("task", () => this.#committedTask(id));
	}

	scanConversations(query: ConversationQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanConversations", () =>
			this.#host.storage.scanConversations(query, limit, cursor, this.#context),
		);
	}

	scanEntries(query: EntryQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanEntries", () => this.#host.storage.scanEntries(query, limit, cursor, this.#context));
	}

	latestHeadMarker(conversationId: ConversationId) {
		return this.#read("latestHeadMarker", () =>
			this.#host.storage.findLatestHeadMarker(conversationId, undefined, this.#context),
		);
	}

	scanTasks(query: TaskQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanTasks", () => this.#host.storage.scanTasks(query, limit, cursor, this.#context));
	}

	/** 内部：已提交的 submission 记录。 */
	submission(id: SubmissionId): Promise<SubmissionRecord | undefined> {
		return this.#read("submission", () => this.#host.storage.submission(id, this.#context));
	}

	/** 已提交的 submission，带有会话作用域的请求 ID。 */
	submissionByRequest(conversationId: ConversationId, requestId: string): Promise<SubmissionRecord | undefined> {
		return this.#read("submissionByRequest", () =>
			this.#host.storage.submissionByRequest(conversationId, requestId, this.#context),
		);
	}

	// ─── 表写入 ───────────────────────────────────────────────────────

	createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord> {
		return this.#write(() => this.#stageConversation(undefined, options.ownership));
	}

	/** 内部：保留的根身份使用的最终形态引导路径。 */
	createRootConversation(): Promise<ConversationRecord> {
		return this.#write(() => this.#stageConversation(undefined, { kind: "ownerless" }, ROOT_CONVERSATION_ID));
	}

	forkConversation(
		parentConversationId: ConversationId,
		at: EntryId,
		options: { readonly ownership: ConversationOwnership },
	): Promise<ConversationRecord> {
		return this.#write(() =>
			this.#stageConversation({ conversationId: parentConversationId, at }, options.ownership),
		);
	}

	async #stageConversation(
		parent: NonNullable<ConversationRecord["parent"]> | undefined,
		ownership: ConversationOwnership,
		reservedId?: ConversationId,
	): Promise<ConversationRecord> {
		const ownerTaskId = ownership.kind === "task" ? ownership.taskId : undefined;
		const id = reservedId ?? (await this.#host.storage.mintId<ConversationId>());
		this.#assertOpen();
		let owner: ConversationRecord["owner"];
		if (ownerTaskId !== undefined) {
			const task = await this.#currentTask(ownerTaskId);
			this.#assertOpen();
			if (task === undefined) throw new Error(`Conversation owner task ${ownerTaskId} does not exist`);
			owner = { conversationId: task.conversationId, taskId: ownerTaskId };
		}
		const record: ConversationRecord = {
			id,
			...(parent === undefined ? {} : { parent }),
			...(owner === undefined ? {} : { owner }),
		};
		const copies =
			parent === undefined
				? []
				: await prepareForkDocumentCopies(this.#host.storage, parent.conversationId, parent.at, id, this.#context);
		this.#assertOpen();
		for (const copy of copies) {
			this.#forkSourceDocumentIds.add(copy.source.id);
			const entry: DocumentEntry = {
				addressId: addressId(copy.record),
				address: copy.record,
				target: { kind: "fork-copy", ...copy },
				retireOnCommit: false,
			};
			this.#documents.push(entry);
			this.#latestDocumentByAddress.set(entry.addressId, entry);
		}
		if (parent !== undefined) this.#forkSourceConversationIds.add(parent.conversationId);
		this.#createdConversationIds.add(id);
		this.#writes.push({ type: "conversation", value: record });
		await this.#host.conversationCreated(this, record);
		this.#assertOpen();
		return record;
	}

	appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
	appendEntry<D extends JsonValue>(
		token: Entry<D>,
		conversationId: ConversationId,
		value: TypedEntryDraft<NoInfer<D>>,
	): Promise<TypedEntry<D>>;
	appendEntry(
		first: ConversationId | { readonly kind: string },
		second: ConversationId | EntryDraft,
		third?: object,
	): Promise<EntryRecord> {
		if (typeof first === "number") return this.#appendEntry(first, second as EntryDraft);
		return this.#appendEntry(second as ConversationId, { ...third, kind: first.kind } as EntryDraft);
	}

	#appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord> {
		return this.#write(async () => {
			await this.#requireConversation(conversationId);
			this.#assertOpen();
			const id = await this.#host.storage.mintId<EntryId>();
			this.#assertOpen();
			const { head, ...rest } = value;
			// 未定义的 `head` 和 `byTaskId` 会在拷贝时被省略。
			const record = copyJson(
				{
					...rest,
					id,
					conversationId,
					head: head === "self" ? id : head,
					byTaskId: this.#scope.taskId,
				},
				TABLE_JSON_COPY_OPTIONS,
			) as unknown as EntryRecord;
			this.#writes.push({ type: "entry", value: record });
			return record;
		});
	}

	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: TaskOptions,
	): Promise<TaskId<R>> {
		return this.#write(async () => {
			const ownership = options.ownership;
			let owner: AnyTaskRecord | undefined;
			if (ownership.kind === "task") {
				// 组装期间会再对照所有者的最终候选记录校验一次。
				owner = await this.#currentTask(ownership.taskId);
				this.#assertOpen();
				if (owner === undefined) throw new Error(`Task owner ${ownership.taskId} does not exist`);
				if (options.background === true) throw new TypeError("A child task cannot be background");
				if (options.conversationId !== undefined && options.conversationId !== owner.conversationId) {
					throw new Error(`A child task lives in its owner's conversation ${owner.conversationId}`);
				}
			}
			const conversationId = owner?.conversationId ?? options.conversationId ?? this.#scope.conversationId;
			if (conversationId === undefined) throw new TypeError("Tx.createTask() requires options.conversationId");
			await this.#requireConversation(conversationId);
			this.#assertOpen();
			const definition = task.definition;
			const checkpoint = definition.initial(input);
			const id = await this.#host.storage.mintId<TaskId<R>>();
			this.#assertOpen();
			const record = copyJson(
				{
					id,
					conversationId,
					kind: definition.name,
					version: definition.version,
					input,
					...(owner === undefined ? {} : { owner: owner.id }),
					background: options.background ?? false,
					abortRequested: false,
					...(options.abandonOnRestart === true ? { abandonOnRestart: true } : {}),
					state: { status: "pending", checkpoint },
				},
				TABLE_JSON_COPY_OPTIONS,
			) as unknown as AnyTaskRecord;
			this.#tasksById.set(id, { write: { kind: "create", record } });
			return id;
		});
	}

	/** 用新 ID 创建一条原始 submission 记录；不适用任何准入规则。 */
	createSubmission(create: SubmissionCreate): Promise<SubmissionRecord> {
		return this.#write(async () => {
			await this.#requireConversation(create.conversationId);
			this.#assertOpen();
			const id = await this.#host.storage.mintId<SubmissionId>();
			this.#assertOpen();
			const record = copyJson({ ...create, id }, TABLE_JSON_COPY_OPTIONS) as unknown as SubmissionRecord;
			this.#submissions.set(id, record);
			return record;
		});
	}

	/**
	 * 结算一个 submission。组装期间针对事务内最新的候选记录解析，并回退到已提交状态，因此它不属于调用方的
	 * 表读取，也能在首次表写入之后使用。
	 */
	settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): void {
		this.#assertOpen();
		this.#hasTableWrite = true;
		this.#submissionChanges.push({ id, change: copyJson(settlement) as SubmissionSettlement });
	}

	/** 将排队的 submission 放置到 `entry`；与 `settleSubmission()` 一样在组装期间解析。 */
	placeSubmission(id: SubmissionId, entry: EntryId): void {
		this.#assertOpen();
		this.#hasTableWrite = true;
		this.#submissionChanges.push({ id, change: { status: "placed", entry } });
	}

	/** 内部：完整替换一条任务记录。任务通过自身运行时改变其状态。 */
	setTask(value: AnyTaskRecord): void {
		this.#assertOpen();
		this.#hasTableWrite = true;
		const task = this.#taskEntry(value.id);
		const candidate = task.write?.record;
		if (candidate?.state.status === "terminal") {
			throw new Error(`Task ${value.id} already has a terminal candidate`);
		}
		if (candidate !== undefined && candidate.conversationId !== value.conversationId) {
			throw new Error(`Task ${value.id} cannot change conversations`);
		}
		task.write = {
			kind: task.write?.kind === "create" ? "create" : "replace",
			record: copyJson(this.#stampTimes(value, candidate), TABLE_JSON_COPY_OPTIONS) as unknown as AnyTaskRecord,
		};
	}

	/** 内部：本事务到目前为止创建或替换的任务的候选记录。 */
	stagedTasks(): AnyTaskRecord[] {
		const records: AnyTaskRecord[] = [];
		for (const task of this.#tasksById.values()) if (task.write !== undefined) records.push(task.write.record);
		return records;
	}

	/** 内部：本事务到目前为止创建或分叉的会话。 */
	stagedConversations(): ConversationRecord[] {
		const records: ConversationRecord[] = [];
		for (const write of this.#writes) if (write.type === "conversation") records.push(write.value);
		return records;
	}

	// ─── 文档 ──────────────────────────────────────────────────────────
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
	doc(token: AnyDocToken, ...args: readonly unknown[]): Promise<Draft<JsonObject>> {
		try {
			this.#assertOpen();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			this.#assertTaskDocumentsOpen(resolved);
			const latest = this.#latestDocumentByAddress.get(resolved.id);
			if (latest !== undefined && !latest.retireOnCommit) {
				if (latest.draftPromise !== undefined) return latest.draftPromise;
				if (latest.target?.kind === "fork-copy") {
					latest.draftPromise = this.#track(this.#acquireForkCopy(latest, definition, latest.target));
					return latest.draftPromise;
				}
			}
			const seed = definition.family === true ? copyJson(args[resolved.nextArgument]) : undefined;
			const docEntry: DocumentEntry = {
				addressId: resolved.id,
				address: resolved.address,
				definition,
				retireOnCommit: false,
			};
			this.#documents.push(docEntry);
			this.#latestDocumentByAddress.set(docEntry.addressId, docEntry);
			// 在 await 之前记录退役意图，使未完成的旧获取与它的替换者保持区分。
			docEntry.draftPromise = this.#track(this.#acquire(docEntry, seed, latest?.retireOnCommit === true));
			return docEntry.draftPromise;
		} catch (error) {
			return Promise.reject(error);
		}
	}

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
	retireDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<void> {
		try {
			this.#assertOpen();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const latest = this.#latestDocumentByAddress.get(resolved.id);
			if (latest?.retireOnCommit) return Promise.resolve();
			if (latest?.target?.kind === "fork-copy") {
				checkRecordScope(definition, latest.target.record);
				latest.retireOnCommit = true;
				return Promise.resolve();
			}
			if (latest?.draftPromise !== undefined) {
				// 退役一个已获取的草稿会先持久化其最终内容再退役。
				latest.retireOnCommit = true;
				return this.#track(latest.draftPromise.then(() => undefined));
			}
			const entry: DocumentEntry = {
				addressId: resolved.id,
				address: resolved.address,
				definition,
				retireOnCommit: true,
			};
			this.#documents.push(entry);
			this.#latestDocumentByAddress.set(entry.addressId, entry);
			return this.#track(this.#findRetirement(entry));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async #acquire(entry: DocumentEntry, seed: JsonValue | undefined, skipLoad: boolean): Promise<Draft<JsonObject>> {
		const definition = entry.definition!;
		const loaded = skipLoad
			? undefined
			: await this.#host.load(definition, entry.addressId, entry.address, this.#context);
		this.#assertOpen();
		if (loaded !== undefined) {
			checkRecordScope(definition, loaded.record);
			checkRecordVersion(definition, loaded.record, loaded.storedVersion);
			entry.target = { kind: "loaded", document: loaded };
			entry.change = loaded.tracker.beginChange();
			return entry.change.state;
		}
		const scope = entry.address.scope;
		if (scope.kind === "conversation") await this.#requireConversation(scope.conversationId);
		if (scope.kind === "task") {
			const task = await this.#currentTask(scope.taskId);
			if (task === undefined) throw new Error(`Task ${scope.taskId} does not exist`);
			if (task.state.status === "terminal") throw new Error(`Task ${scope.taskId} is terminal`);
		}
		this.#assertOpen();
		const value = copyJson(
			definition.family === true ? definition.initial(seed) : definition.initial(),
		) as JsonObject;
		const id = await this.#host.storage.mintId<DocumentId>();
		this.#assertOpen();
		const tracker = track(value);
		entry.target = {
			kind: "created",
			record: documentCreate(definition, entry.address, id),
			version: definition.version,
			tracker,
		};
		entry.change = tracker.beginChange();
		return entry.change.state;
	}

	async #acquireForkCopy(
		entry: DocumentEntry,
		definition: AnyDocDefinition,
		target: Extract<DocumentTarget, { readonly kind: "fork-copy" }>,
	): Promise<Draft<JsonObject>> {
		const stored = await this.#host.storage.document(target.source.id, target.source.at, this.#context);
		this.#assertOpen();
		if (stored === undefined) {
			throw new Error(`Fork source document ${target.source.id} cannot be read`);
		}
		if (
			stored.record.scope.kind !== "conversation" ||
			stored.record.kind !== target.record.kind ||
			stored.record.key !== target.record.key ||
			stored.record.history !== target.record.history ||
			stored.record.fork !== target.record.fork
		) {
			throw new Error(`Fork source document ${target.source.id} does not match the copied record`);
		}
		const value = materializeDocumentValue(definition, target.record, stored.version, stored.value);
		const tracker = track(value);
		entry.definition = definition;
		entry.target = { kind: "created", record: target.record, version: definition.version, tracker };
		entry.change = tracker.beginChange();
		return entry.change.state;
	}

	async #findRetirement(entry: DocumentEntry): Promise<void> {
		const record =
			this.#host.cached(entry.addressId)?.record ??
			(await this.#host.storage.findDocument(entry.address, "current", this.#context));
		this.#assertOpen();
		if (record === undefined) return;
		checkRecordScope(entry.definition!, record);
		entry.target = { kind: "retire-only", record };
	}

	// ─── 结算 ─────────────────────────────────────────────────────────
	async settleFailure(): Promise<void> {
		this.#sealed = true;
		this.#abortChanges();
		await Promise.allSettled(this.#pendingOperations);
	}

	/**
	 * 回调成功后封印（seal），准备每一个未决变更，并组装原子批次。
	 * 任何失败都会在写入存储之前中止所有变更。
	 */
	async settleSuccess(): Promise<readonly StorageWrite[]> {
		this.#sealed = true;
		if (this.#pendingOperations.size > 0) {
			this.#abortChanges();
			await Promise.allSettled(this.#pendingOperations);
			throw new Error("Session commit callback settled before its pending Tx operations");
		}
		try {
			// 同步准备每一个未决变更；这会撤销每一个草稿。
			for (const document of this.#documents) {
				if (document.change !== undefined) document.prepared = document.change.prepare();
			}
			return await this.#assemble();
		} catch (error) {
			this.#abortChanges();
			throw error;
		}
	}

	/** 存储失败后或无需写入时，中止每一个已准备的变更。 */
	discard(): void {
		this.#abortChanges();
	}

	/** 存储成功后通过指针交换采纳每一个已准备的变更，并描述发布内容。 */
	adopt(seq: Seq): DocumentCommitChange[] {
		const publications: DocumentCommitChange[] = [];
		for (const plan of this.#plans) {
			const committed = "createdAt" in plan.record;
			let record: DocumentRecord = committed ? (plan.record as DocumentRecord) : { ...plan.record, createdAt: seq };
			if (plan.retire) record = { ...record, retiredAt: seq };
			const change = plan.change;
			if (change !== undefined) {
				const { tracker, prepared, loaded, version } = change;
				// 新化身会被采纳，除非它在同一次提交中退役；已加载的化身只有发生变更时才被采纳。
				if (loaded === undefined ? !plan.retire : prepared.ops.length > 0) tracker.adopt(prepared);
				else prepared.abort();
				if (loaded !== undefined) {
					if (loaded.storedVersion < version) loaded.storedVersion = version;
					if (plan.content?.type === "document.change") {
						if (plan.content.content.kind === "base") loaded.deltasSinceBase = 0;
						else loaded.deltasSinceBase++;
					}
				} else if (!plan.retire) {
					this.#host.install({
						addressId: plan.addressId,
						record,
						storedVersion: version,
						valueVersion: version,
						deltasSinceBase: 0,
						tracker,
					});
				}
			}
			const conversationId = plan.conversationId;
			if (plan.retire) {
				if (committed) this.#host.evict(plan.addressId, record.id);
				const retired = { version: undefined, value: null, ops: EMPTY_OPERATIONS };
				publications.push({ type: "document", record, conversationId, ...retired });
			} else if (plan.content?.type === "document.copy") {
				publications.push({
					type: "document.copy",
					record,
					conversationId: conversationId!,
					source: plan.content.source,
				});
			} else if (change !== undefined && publishes(plan)) {
				const ops = change.loaded === undefined ? EMPTY_OPERATIONS : change.prepared.ops;
				publications.push({
					type: "document",
					record,
					conversationId,
					version: change.version,
					value: change.prepared.value,
					ops,
				});
			}
		}
		return publications;
	}

	async #assemble(): Promise<StorageWrite[]> {
		const storage = this.#host.storage;
		const plans = this.#plans;
		for (const document of this.#documents) {
			const plan = planDocument(document);
			if (plan !== undefined) plans.push(plan);
		}
		this.#rejectForkSourceWrites(plans);
		await this.#validateOwners();
		for (const [id, task] of this.#tasksById) {
			if (task.write?.kind !== "replace") continue;
			const committed = await this.#committedTask(id);
			if (committed === undefined) throw new Error(`Task ${id} does not exist`);
			if (committed.state.status === "terminal") throw new Error(`Task ${id} is already terminal`);
			if (committed.conversationId !== task.write.record.conversationId) {
				throw new Error(`Task ${id} cannot change conversations`);
			}
		}

		// 终端结算会退役每一个任务文档，包括本事务创建的那些。
		const terminalTaskIds = new Set<TaskId>();
		for (const task of this.#tasksById.values()) {
			if (task.write?.record.state.status === "terminal") terminalTaskIds.add(task.write.record.id);
		}
		if (terminalTaskIds.size > 0) {
			const retiring = new Set<DocumentId>();
			for (const plan of plans) {
				const scope = plan.record.scope;
				if (scope.kind !== "task" || !terminalTaskIds.has(scope.taskId)) continue;
				plan.retire = true;
				retiring.add(plan.record.id);
			}
			for (const taskId of terminalTaskIds) {
				if (this.#tasksById.get(taskId)?.write?.kind === "create") continue;
				let cursor: Cursor | undefined;
				do {
					const page = await storage.scanDocuments(
						{ scope: { kind: "task", taskId }, at: "current" },
						INTERNAL_SCAN_PAGE_SIZE,
						cursor,
						this.#context,
					);
					for (const record of page.items) {
						if (retiring.has(record.id)) continue;
						plans.push({ addressId: addressId(record), record, retire: true });
						retiring.add(record.id);
					}
					cursor = page.next;
				} while (cursor !== undefined);
			}
		}

		// 在写入存储之前解析发布归属，使 adoption 保持同步。
		for (const plan of plans) {
			if (!publishes(plan)) continue;
			const scope = plan.record.scope;
			if (scope.kind === "conversation") plan.conversationId = scope.conversationId;
			if (scope.kind !== "task") continue;
			const task = this.#taskEntry(scope.taskId);
			if (task.publicationConversationId === undefined) {
				const current = await this.#currentTask(scope.taskId);
				if (current !== undefined) task.publicationConversationId = current.conversationId;
			}
			plan.conversationId = task.publicationConversationId;
		}

		for (const { id, change } of this.#submissionChanges) {
			const current = this.#submissions.get(id) ?? (await storage.submission(id, this.#context));
			if (current === undefined) throw new Error(`Submission ${id} does not exist`);
			const next = applySubmissionChange(current, change);
			if (next !== current) this.#submissions.set(id, next);
		}

		const writes = this.#writes;
		for (const value of this.#submissions.values()) writes.push({ type: "submission", value });
		for (const task of this.#tasksById.values()) {
			if (task.write !== undefined) writes.push({ type: "task", value: task.write.record });
		}
		for (const plan of plans) {
			const change = plan.change;
			// 检查点谓词最后运行，在所有校验之后。
			if (plan.content?.type === "document.change" && plan.content.content.kind === "delta" && change?.loaded) {
				const { prepared, version } = change;
				const info = { deltasSinceBase: change.loaded.deltasSinceBase };
				if (change.definition?.checkpointWhen?.(prepared.value, prepared.ops, info)) {
					plan.content = { ...plan.content, content: { version, kind: "base", value: prepared.value } };
				}
			}
			if (plan.content !== undefined) writes.push(plan.content);
			if (plan.retire) writes.push({ type: "document.retire", id: plan.record.id });
		}
		return writes;
	}

	// ─── 辅助方法 ────────────────────────────────────────────────────────────

	/**
	 * 新的任务资产需要一个活跃的所有者，以所有者的最终候选记录为准：不能是 `completing`、terminal 或
	 * 已标记中止。因此任务无法在终结它自己的那次提交中创建任务资产（spec §5.5）。
	 */
	async #validateOwners(): Promise<void> {
		const owners: { readonly what: string; readonly taskId: TaskId }[] = [];
		for (const write of this.#writes) {
			if (write.type !== "conversation" || write.value.owner === undefined) continue;
			owners.push({ what: "Conversation owner task", taskId: write.value.owner.taskId });
		}
		for (const task of this.#tasksById.values()) {
			const record = task.write?.kind === "create" ? task.write.record : undefined;
			if (record?.owner !== undefined) owners.push({ what: "Task owner", taskId: record.owner });
		}
		for (const { what, taskId } of owners) {
			const task = await this.#currentTask(taskId);
			if (task === undefined) throw new Error(`${what} ${taskId} does not exist`);
			if (task.state.status === "terminal" || task.state.status === "completing") {
				throw new Error(`${what} ${taskId} is ${task.state.status}`);
			}
			if (task.abortRequested) throw new Error(`${what} ${taskId} is abort-marked`);
		}
	}

	#rejectForkSourceWrites(plans: readonly DocumentPlan[]): void {
		for (const plan of plans) {
			if (plan.content === undefined && !plan.retire) continue;
			const record = plan.record;
			if (this.#forkSourceDocumentIds.has(record.id)) {
				throw new Error(`Cannot change fork source document ${record.id} in the fork transaction`);
			}
			const scope = plan.record.scope;
			if (
				scope.kind === "conversation" &&
				this.#forkSourceConversationIds.has(scope.conversationId) &&
				record.scope.kind === "conversation" &&
				record.fork === "current"
			) {
				throw new Error(
					`Cannot fork conversation ${scope.conversationId} while changing its current-policy documents`,
				);
			}
		}
	}

	#abortChanges(): void {
		for (const document of this.#documents) document.change?.abort();
	}

	#assertOpen(): void {
		if (this.#sealed) throw new Error("Transaction has settled");
	}

	#assertTaskDocumentsOpen(resolved: ResolvedAddress): void {
		const scope = resolved.address.scope;
		if (scope.kind === "task" && this.#tasksById.get(scope.taskId)?.write?.record.state.status === "terminal") {
			throw new Error(`Task ${scope.taskId} is terminal`);
		}
	}

	/** 登记一个操作，使回调结算能够拒绝并清空它。 */
	#track<T>(operation: Promise<T>): Promise<T> {
		this.#pendingOperations.add(operation);
		const settle = (): void => {
			this.#pendingOperations.delete(operation);
		};
		operation.then(settle, settle);
		return operation;
	}

	#read<T>(method: string, read: () => Promise<T>): Promise<T> {
		try {
			this.#assertOpen();
			if (this.#hasTableWrite) throw new ReadAfterWrite(method);
			return this.#track(read());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	#write<T>(write: () => Promise<T>): Promise<T> {
		try {
			this.#assertOpen();
			this.#hasTableWrite = true;
			return this.#track(write());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async #requireConversation(id: ConversationId): Promise<void> {
		if (this.#createdConversationIds.has(id)) return;
		if ((await this.#host.storage.conversation(id, this.#context)) === undefined) {
			throw new Error(`Conversation ${id} does not exist`);
		}
	}

	/**
	 * 生命周期时间：首次变为 `running` 时记录 `startedAt`，变为 `terminal` 时记录 `endedAt`。一旦设置，它们会从
	 * 被替换的记录延续下来；早于这些字段存在的记录则没有它们。
	 */
	#stampTimes(value: AnyTaskRecord, candidate: AnyTaskRecord | undefined): AnyTaskRecord {
		const status = value.state.status;
		const now = (stamps: boolean) => (stamps ? this.#host.now() : undefined);
		const startedAt = candidate?.startedAt ?? value.startedAt ?? now(status === "running");
		const endedAt = candidate?.endedAt ?? value.endedAt ?? now(status === "terminal");
		if (startedAt === value.startedAt && endedAt === value.endedAt) return value;
		return {
			...value,
			...(startedAt === undefined ? {} : { startedAt }),
			...(endedAt === undefined ? {} : { endedAt }),
		};
	}

	#taskEntry(id: TaskId): TransactionTask {
		let task = this.#tasksById.get(id);
		if (task === undefined) {
			task = {};
			this.#tasksById.set(id, task);
		}
		return task;
	}

	/** 最新的候选任务记录，回退到已提交状态；不属于调用方的表读取。 */
	async #currentTask(id: TaskId): Promise<AnyTaskRecord | undefined> {
		return this.#tasksById.get(id)?.write?.record ?? (await this.#committedTask(id));
	}

	#committedTask(id: TaskId): Promise<AnyTaskRecord | undefined> {
		const task = this.#taskEntry(id);
		task.committedRead ??= this.#host.storage.task(id, this.#context);
		return task.committedRead;
	}
}

/** 一个暂存文档的计划：记录、内容写入和已准备的变更。退役稍后决定。 */
function planDocument(document: DocumentEntry): DocumentPlan | undefined {
	const target = document.target;
	if (target === undefined) return undefined;
	const plan = { addressId: document.addressId, retire: document.retireOnCommit };
	switch (target.kind) {
		case "created": {
			const prepared = document.prepared!;
			const { record, version, tracker } = target;
			const content = { version, kind: "base", value: prepared.value } as const;
			return {
				...plan,
				record,
				content: { type: "document.create", record, content },
				change: { tracker, prepared, version },
			};
		}
		case "fork-copy":
			return {
				...plan,
				record: target.record,
				content: { type: "document.copy", record: target.record, source: target.source },
			};
		case "retire-only":
			return { ...plan, record: target.record };
		case "loaded": {
			const loaded = target.document;
			const definition = document.definition!;
			const prepared = document.prepared!;
			const version = definition.version;
			const id = loaded.record.id;
			// 版本变更即使没有操作也会存储基线；否则只有变更才存储增量。
			const content =
				loaded.storedVersion < version
					? ({ type: "document.change", id, content: { version, kind: "base", value: prepared.value } } as const)
					: prepared.ops.length > 0
						? ({ type: "document.change", id, content: { version, kind: "delta", ops: prepared.ops } } as const)
						: undefined;
			const change = {
				tracker: loaded.tracker,
				prepared,
				version,
				loaded,
				definition,
			};
			return { ...plan, record: loaded.record, change, ...(content === undefined ? {} : { content }) };
		}
	}
}

/**
 * adoption 是否发布该计划：所有创建、复制和退役，以及写入内容的已加载化身——这包括仅用于迁移的基线，
 * 使旧形态的观察者能收到新值。
 */
function publishes(plan: DocumentPlan): boolean {
	return plan.retire || plan.change?.loaded === undefined || plan.content !== undefined;
}
