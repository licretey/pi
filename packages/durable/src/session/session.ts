import { type Context, type JsonValue, replicatedState } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withoutAbortSignal } from "@earendil-works/chord/context";
import { type Op, track } from "@earendil-works/chord/delta";
import {
	type AnyDocToken,
	checkRecordScope,
	checkRecordVersion,
	materializeDocument,
	resolveAddress,
} from "../documents.ts";
import { SessionFailed, StorageRequestError } from "../errors.ts";
import { idFromNumber } from "../ids.ts";
import type {
	CommitChange,
	CommitPublication,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentCommitChange,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	DocumentState,
	DocumentWatch,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	JsonObject,
	Page,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	Seq,
	Session,
	SessionDocFamilyToken,
	SessionDocToken,
	SessionEnd,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	TaskQuery,
	TaskRecord,
	Tx,
} from "../types.ts";
import {
	CommittedStateSource,
	CommittedWatch,
	type ObservedDocumentValue,
	RETIREMENT_OPERATIONS,
} from "./observation.ts";
import { type LoadedDocument, Transaction, type TransactionHost, type TransactionScope } from "./transaction.ts";

/**
 * 在一个存储后端之上打开 Session 内核。`now` 是任务时间所用的墙钟；默认 `Date.now`。
 * Storage 方法抛出的第一个错误会使 Session 失败（`SessionFailed`）；见 `SessionImpl`。
 */
export function createSession(storage: Storage, options?: { readonly now?: () => number }): Session {
	return new SessionImpl(storage, options?.now);
}

/**
 * Session 内核：一条变更线、已加载文档的 tracker 缓存，以及已提交状态的发布。
 *
 * 只有已提交的状态可被观察。每个 commit 回调、预备、Storage 落定、收养与发布入队，都在持有变更线时运行；
 * 监听器随后运行。
 *
 * Storage 失败是终局。每个 Storage 调用都经过同一个守卫：Storage 方法抛出的第一个错误——调用方被取消的
 * 除外——会使 Session 失败，无法收养的 commit 同样如此。该调用得到那个错误；此后每个调用、以及每一个仍在途的
 * Storage 调用都会得到 `SessionFailed`；close 监听器立即带着该错误运行，随后 Session 关闭自身——包括 Storage——
 * 并且 `closed` 落定。没有任何东西会重试：瞬时错误由 Storage 自己去重试。重新打开可从已提交的内容中恢复。
 */
export class SessionImpl implements Session {
	readonly #storage: Storage;
	readonly #documents = new Map<string, LoadedDocument>();
	readonly #commitListeners = new Set<(publication: CommitPublication, context: Context) => void>();
	/** Session 自身的监听器（如其 scheduler 的）：它们让内存与存储保持同步，因此抛错会使 Session 失败。 */
	readonly #internalListeners = new Set<(publication: CommitPublication, context: Context) => void>();
	readonly #closeListeners = new Set<() => void>();
	readonly #host: TransactionHost;
	#tail: Promise<void> = Promise.resolve();
	#closing: Promise<void> | undefined;
	#failure: { readonly error: unknown } | undefined;
	/** close 触达后端时设置：从那时起，失败的调用都因关闭而失败。 */
	readonly #failed = Promise.withResolvers<never>();
	readonly #closed = Promise.withResolvers<SessionEnd>();

	get closed(): Promise<SessionEnd> {
		return this.#closed.promise;
	}

	/** 内部：使 Session 失败的错误（如果有的话）。 */
	get failure(): { readonly error: unknown } | undefined {
		return this.#failure;
	}

	/** 内部：Session 一失败就以 `SessionFailed` reject——先于在途工作结束；永不 resolve。 */
	get failed(): Promise<never> {
		return this.#failed.promise;
	}

	constructor(storage: Storage, now: () => number = Date.now) {
		// 等待方会与它竞速；谁都不必赢。
		this.#failed.promise.catch(() => {});
		this.#storage = new GuardedStorage(storage, this);
		this.#host = {
			storage: this.#storage,
			now,
			cached: (id) => this.#documents.get(id),
			load: (definition, addressId, address, context) => this.#loadDocument(definition, addressId, address, context),
			install: (document) => {
				this.#documents.set(document.addressId, document);
			},
			evict: (id, recordId) => {
				if (this.#documents.get(id)?.record.id === recordId) this.#documents.delete(id);
			},
			conversationCreated: (tx, record) => this.conversationCreated(tx, record),
		};
	}

	/** 失败守卫之后的 Storage；每个组件都通过它读写。 */
	protected get storage(): Storage {
		return this.#storage;
	}

	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
		return this.commitWith(change, context);
	}

	/**
	 * 内部：以 `error` 使 Session 失败——先到者生效——并上报一次。准入随即结束，close 监听器立即运行；
	 * 它们从 `failure` 读取错误。Storage 守卫会调用它；当 scheduler 自身的 commit 中抛错时，Harness 也会调用它。
	 */
	fail(error: unknown): void {
		if (this.#failure !== undefined) return;
		this.#failure = { error };
		this.#failed.reject(new SessionFailed(error));
		// 先密封，这样回调进来的上报处理器看到的才是已失败的 Session。关闭过程同步运行 close 监听器；
		// 后端 close 失败由调用方自己看管，这里没有人等待。
		this.close(BACKGROUND_CONTEXT).catch(() => {});
		this.report(error);
	}

	/**
	 * 内部 commit，暴露具体事务及其内部操作，例如保留 ID 的根引导与任务替换。`scope` 设定 `tx.createTask()` 的
	 * 默认 conversation，以及追加 entry 所归属的任务。
	 */
	commitWith<T>(change: (tx: Transaction) => T | Promise<T>, context: Context, scope?: TransactionScope): Promise<T> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#enqueue(() => this.#runCommit(change, context, scope));
	}

	/** 内部：在变更线上运行只读作业，使多次读取的派生观察到同一个已提交状态。 */
	readOnLine<T>(job: () => Promise<T>): Promise<T> {
		try {
			this.assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#enqueue(async () => {
			this.#assertHealthy();
			return job();
		});
	}

	/**
	 * 内部：一个 conversation 文档的当前世代与取值，供已在线上运行的作业使用（见 `readOnLine()`）。
	 * 文档不存在时为 `undefined`。
	 */
	async conversationDocumentOnLine(
		token: ConversationDocToken<JsonObject>,
		conversationId: ConversationId,
		context: Context,
	): Promise<{ readonly record: DocumentRecord; readonly version: number; readonly value: JsonObject } | undefined> {
		const definition = token.definition;
		const resolved = resolveAddress(definition, [conversationId, context]);
		const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
		if (loaded === undefined) return undefined;
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		return { record: loaded.record, version: loaded.valueVersion, value: loaded.tracker.value };
	}

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
	async snapshot(token: AnyDocToken, ...args: readonly unknown[]): Promise<JsonObject | undefined> {
		this.assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const context = args[resolved.nextArgument] as Context;
		const cached = this.#documents.get(resolved.id);
		const loaded =
			cached?.valueVersion === definition.version
				? cached
				: await this.#enqueue(async () => {
						this.#assertHealthy();
						return this.#loadDocument(definition, resolved.id, resolved.address, context);
					});
		if (loaded === undefined) return undefined;
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		return loaded.tracker.value;
	}

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
	documentState(token: AnyDocToken, ...args: readonly unknown[]): Promise<DocumentState<JsonObject> | undefined> {
		try {
			this.assertUsable();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const context = args[resolved.nextArgument] as Context;
			return this.#enqueue(async () => {
				this.#assertHealthy();
				const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
				if (loaded === undefined) return undefined;
				const { observer: source, detach } = this.#attachDocument(
					definition,
					loaded,
					(value, release) => new CommittedStateSource<ObservedDocumentValue>(value, release),
				);
				try {
					return replicatedState(source, { onError: (error) => this.report(error) }) as DocumentState<JsonObject>;
				} catch (error) {
					detach();
					throw error;
				}
			});
		} catch (error) {
			return Promise.reject(error);
		}
	}

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
	async watchDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<DocumentWatch<JsonObject> | undefined> {
		this.assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const context = args[resolved.nextArgument] as Context;
		const signal = context.abortSignal;
		let cancelled = signal?.aborted ?? false;
		const markCancelled = (): void => {
			cancelled = true;
		};
		signal?.addEventListener("abort", markCancelled, { once: true });
		try {
			const watch = await this.#enqueue(async () => {
				this.#assertHealthy();
				if (cancelled) throw cancellationError(signal!);
				const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
				if (cancelled) throw cancellationError(signal!);
				if (loaded === undefined) return undefined;
				return this.#attachDocument(
					definition,
					loaded,
					(value, release) =>
						new CommittedWatch<ObservedDocumentValue>(value, release, (error) => this.report(error)),
				).observer;
			});
			if (watch === undefined) return undefined;
			if (cancelled) {
				watch.cancel();
				throw cancellationError(signal!);
			}
			if (signal !== undefined) watch.observeCancellation(signal);
			return watch as DocumentWatch<JsonObject>;
		} finally {
			signal?.removeEventListener("abort", markCancelled);
		}
	}

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
	async snapshotAsOf(token: AnyDocToken, ...args: readonly unknown[]): Promise<JsonObject | undefined> {
		this.assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		if (resolved.address.scope.kind !== "conversation") {
			throw new TypeError("Session.snapshotAsOf() requires a conversation document");
		}
		const conversationId = resolved.address.scope.conversationId;
		const atValue = args[resolved.nextArgument];
		if (typeof atValue !== "number" || !Number.isSafeInteger(atValue)) {
			throw new TypeError("Session.snapshotAsOf() requires an entry ID");
		}
		const at = idFromNumber<EntryId>(atValue);
		const context = args[resolved.nextArgument + 1] as Context;
		return this.#enqueue(async () => {
			this.#assertHealthy();
			const storedEntry = await this.#storage.entry(conversationId, at, context);
			if (storedEntry === undefined) {
				throw new Error(`Entry ${at} is not visible from conversation ${conversationId}`);
			}
			const address: DocumentAddress = {
				...resolved.address,
				scope: { kind: "conversation", conversationId: storedEntry.entry.conversationId },
			};
			const record = await this.#storage.findDocument(address, storedEntry.commitSeq, context);
			if (record === undefined) return undefined;
			const stored = await this.#storage.document(record.id, storedEntry.commitSeq, context);
			if (stored === undefined) {
				throw new Error(`Historical document ${record.id} (${record.kind}) cannot be read`);
			}
			return materializeDocument(definition, stored);
		});
	}

	close(context: Context): Promise<void> {
		if (this.#closing === undefined) {
			const cleanup = withoutAbortSignal(context);
			// 在其他任何事运行之前先密封准入，然后停下观察者；已准入的工作在 Storage 关闭前落定。
			this.#closing = Promise.resolve()
				.then(() => this.beforeClose())
				.then(() =>
					this.#enqueue(async () => {
						this.#commitListeners.clear();
						this.#internalListeners.clear();
						this.#documents.clear();
						try {
							await this.#storage.close(cleanup);
						} catch (error) {
							// 无法关闭的 Storage 即失败的 Storage；先前的失败仍作为原因保留。
							if (this.#failure === undefined) {
								this.#failure = { error };
								this.report(error);
							}
							throw error;
						}
					}),
				)
				.finally(() => {
					const failure = this.#failure;
					this.#closed.resolve(
						failure === undefined ? { reason: "closed" } : { reason: "failed", error: failure.error },
					);
				});
			this.#notifyClose();
		}
		return awaitWithContext(this.#closing, context);
	}

	/** 运行一次各 close 监听器，彼此独立：失败的那个被上报，其余照常运行。 */
	#notifyClose(): void {
		const listeners = [...this.#closeListeners];
		this.#closeListeners.clear();
		for (const listener of listeners) contained(listener, (error) => this.report(error));
	}

	/** 内部：Session 的失败与各监听器的错误；监听器错误绝不会使其运行者失败。朴素的 Session 将其丢弃。 */
	report(_error: unknown): void {}

	/**
	 * 在创建或 fork conversation 的每个事务中运行，位于 conversation 记录暂存之后。朴素的 Session 不暂存任何东西；
	 * Harness 则暂存它的内置文档。
	 */
	protected conversationCreated(_tx: Transaction, _record: ConversationRecord): Promise<void> {
		return Promise.resolve();
	}

	/** 在 close 密封准入之后、变更线关闭 Storage 之前运行；绝不 reject。 */
	protected beforeClose(): Promise<void> {
		return Promise.resolve();
	}

	/** 注册同步的收养后监听器。它不得阻塞或调用 Session 操作；抛错会被上报。 */
	subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void {
		this.assertUsable();
		this.#commitListeners.add(listener);
		return () => this.#commitListeners.delete(listener);
	}

	/**
	 * 内部：为 Session 自身组件提供的 `subscribeCommits()`，它们的状态跟随每次 commit。抛错会让该状态落后于
	 * 存储，因此那会使 Session 失败，而不是仅被上报。它们在宿主监听器之前运行。
	 */
	observeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void {
		this.assertUsable();
		this.#internalListeners.add(listener);
		return () => this.#internalListeners.delete(listener);
	}

	/**
	 * 注册一个监听器：close 开始时同步调用；当失败迫使 Session 关闭时同样调用（此时 `failure` 已设置）。
	 * 它不得阻塞或调用 Session 操作；抛错会被上报。
	 */
	subscribeClose(listener: () => void): () => void {
		this.assertUsable();
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	/** 在变更线上丢弃所有已加载的 tracker；之后再访问就从 Storage 冷加载。 */
	unloadDocuments(): Promise<void> {
		return this.#enqueue(async () => {
			this.#documents.clear();
		});
	}

	async #runCommit<T>(
		change: (tx: Transaction) => T | Promise<T>,
		context: Context,
		scope?: TransactionScope,
	): Promise<T> {
		this.#assertHealthy();
		context.abortSignal?.throwIfAborted();
		const tx = new Transaction(this.#host, context, scope);
		let result: T;
		try {
			result = await change(tx);
			// 捕获到失败读取的回调既不能提交，也不能装作提交过而成功返回。
			this.#assertHealthy();
		} catch (error) {
			await tx.settleFailure();
			throw error;
		}
		const writes = await tx.settleSuccess();
		if (writes.length === 0) {
			tx.discard();
			return result;
		}
		let seq: Seq;
		try {
			// 一旦准入，调用方的取消就不会打断 Storage 落定。
			seq = await this.#storage.commit(writes, withoutAbortSignal(context));
		} catch (error) {
			// 守卫已使 Session 失败。
			tx.discard();
			throw error;
		}
		let documents: DocumentCommitChange[];
		try {
			documents = tx.adopt(seq);
		} catch (error) {
			// Storage 已提交；收养失败会让内存落后于持久化状态。
			this.fail(error);
			throw error;
		}
		this.#publish(seq, writes, documents, context);
		return result;
	}

	#publish(
		seq: Seq,
		writes: readonly StorageWrite[],
		documents: readonly DocumentCommitChange[],
		context: Context,
	): void {
		if (this.#commitListeners.size === 0 && this.#internalListeners.size === 0) return;
		const changes: CommitChange[] = [];
		for (const write of writes) {
			switch (write.type) {
				case "conversation":
				case "entry":
				case "task":
				case "submission":
					changes.push(write);
			}
		}
		for (const document of documents) changes.push(document);
		const publication: CommitPublication = { seq, changes };
		// commit 已持久化：失败的监听器既不会让 commit 失败，也不会跳过其他监听器。
		for (const listener of [...this.#internalListeners]) {
			contained(
				() => listener(publication, context),
				(error) => this.fail(error),
			);
		}
		for (const listener of [...this.#commitListeners]) {
			contained(
				() => listener(publication, context),
				(error) => this.report(error),
			);
		}
	}

	/**
	 * 将观察者附着一个已提交世代：先校验定义，然后转发该世代的已提交变更与关闭。`detach` 移除两个订阅。
	 */
	#attachDocument<O extends CommittedStateSource | CommittedWatch>(
		definition: AnyDocToken["definition"],
		loaded: LoadedDocument,
		create: (value: JsonObject, detach: () => void) => O,
	): { observer: O; detach: () => void } {
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		let unsubscribeCommit = (): void => {};
		let unsubscribeClose = (): void => {};
		const detach = (): void => {
			unsubscribeCommit();
			unsubscribeClose();
		};
		const observer = create(loaded.tracker.value, detach);
		const observed = { version: loaded.valueVersion };
		unsubscribeCommit = this.observeCommits((publication, context) => {
			for (const change of publication.changes) {
				if (change.type !== "document" || change.record.id !== loaded.record.id) continue;
				// document state 的 frame 不携带调用方的取消；watch 自己观察自己的取消。
				const frameContext = observer instanceof CommittedStateSource ? withoutAbortSignal(context) : context;
				const ops = observedOperations(observed, change);
				// 仅迁移的基线对新版本的观察者来说没有任何变化。
				if (ops.length === 0) continue;
				observer.advance(change.value, ops, frameContext);
			}
		});
		unsubscribeClose = this.subscribeClose(() => observer.closeSession(this.#failure));
		return { observer, detach };
	}

	async #loadDocument(
		definition: AnyDocToken["definition"],
		addressId: string,
		address: DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined> {
		const cached = this.#documents.get(addressId);
		// tracker 只服务其取值被具体化时所针对版本的 token；其他版本从 Storage 重新加载。
		if (cached?.valueVersion === definition.version) return cached;
		if (cached !== undefined) this.#documents.delete(addressId);
		const record = await this.#storage.findDocument(address, "current", context);
		if (record === undefined) return undefined;
		const stored = await this.#storage.document(record.id, "current", context);
		if (stored === undefined) throw new Error(`Current document ${record.id} (${record.kind}) cannot be read`);
		const value = materializeDocument(definition, stored);
		const loaded: LoadedDocument = {
			addressId,
			record: stored.record,
			storedVersion: stored.version,
			valueVersion: definition.version,
			deltasSinceBase: stored.deltasSinceBase,
			tracker: track(value),
		};
		this.#documents.set(addressId, loaded);
		return loaded;
	}

	#enqueue<T>(job: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(job);
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** 内部：已失败时抛 `SessionFailed`，否则在关闭中抛普通错误。 */
	assertUsable(): void {
		this.#assertHealthy();
		if (this.#closing !== undefined) throw new Error("Session is closed");
	}

	#assertHealthy(): void {
		if (this.#failure !== undefined) throw new SessionFailed(this.#failure.error);
	}
}

/**
 * 运行一个不得让其调用方失败的宿主回调：抛出的错误、或它返回的 promise 的 reject，都交给 `onError`，
 * 且不会等待它。
 */
export function contained(callback: () => unknown, onError: (error: unknown) => void): void {
	try {
		const result = callback();
		// 任意 thenable，包括来自另一个 realm 的 promise；`Promise.resolve` 会用它自己的 handler 收养它。
		if (typeof (result as { then?: unknown } | null)?.then === "function") Promise.resolve(result).catch(onError);
	} catch (error) {
		onError(error);
	}
}

/**
 * 观察者为一次已提交变更应用的操作。以另一个定义版本水合的观察者持有形状不同的取值，因此它收到的
 * 是以根替换方式给出的新值，而非针对那种形状的操作。
 */
function observedOperations(
	observed: { version: number },
	change: Extract<DocumentCommitChange, { readonly type: "document" }>,
): readonly Op[] {
	if (change.value === null) return RETIREMENT_OPERATIONS;
	if (change.version === observed.version) return change.ops;
	observed.version = change.version!;
	return [["r", change.value]];
}

function cancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

/** 守卫需要 Session 提供的东西：到目前为止的失败，以及使它失败的方法。 */
type FailureLatch = {
	readonly failure: { readonly error: unknown } | undefined;
	fail(error: unknown): void;
};

/**
 * 失败守卫之后的 Session Storage；Session 的每个组件都通过它读写。调用之前，已失败的 Session 直接得到
 * `SessionFailed`，不会触达后端。抛错的调用会使 Session 失败并重新抛出后端的错误——除非那是一个
 * `StorageRequestError`，或调用方 context 已被取消的读取：这两者都不能说明 Storage 已损坏。
 * `close()` 总会触达后端，因此已失败的 Session 仍会关闭它。
 */
class GuardedStorage implements Storage {
	readonly #storage: Storage;
	readonly #latch: FailureLatch;
	/** 在途的后端调用，包括离开 Session 线的那些；close 会等它们结束再关闭后端。 */
	readonly #underway = new Set<Promise<unknown>>();
	#closing = false;

	constructor(storage: Storage, latch: FailureLatch) {
		this.#storage = storage;
		this.#latch = latch;
	}

	/** 永不豁免，无论它抛出什么：一旦准入，失败的批次是否已提交就不得而知。 */
	commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
		return this.#call(undefined, () => this.#storage.commit(writes, context));
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.#call(undefined, () => this.#storage.mintId<I>());
	}

	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
		return this.#call(context, () => this.#storage.conversation(id, context));
	}

	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.#call(context, () => this.#storage.scanConversations(query, limit, cursor, context));
	}

	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		first: EntryId | ConversationId,
		second: EntryId | Context,
		third?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		if (third === undefined) {
			const context = second as Context;
			return this.#call(context, () => this.#storage.entry(first as EntryId, context));
		}
		return this.#call(third, () => this.#storage.entry(first as ConversationId, second as EntryId, third));
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.#call(context, () => this.#storage.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context));
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.#call(context, () => this.#storage.scanEntries(query, limit, cursor, context));
	}

	task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
		return this.#call(context, () => this.#storage.task(id, context));
	}

	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>> {
		return this.#call(context, () => this.#storage.scanTasks(query, limit, cursor, context));
	}

	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		return this.#call(context, () => this.#storage.submission(id, context));
	}

	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.#call(context, () => this.#storage.scanSubmissions(query, limit, cursor, context));
	}

	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.#call(context, () => this.#storage.submissionByRequest(conversationId, requestId, context));
	}

	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
		return this.#call(context, () => this.#storage.findDocument(address, at, context));
	}

	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
		return this.#call(context, () => this.#storage.document(id, at, context));
	}

	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.#call(context, () => this.#storage.scanDocuments(query, limit, cursor, context));
	}

	/**
	 * 待每个在途调用落定后关闭后端，使它们既不比后端活得久，也不会在 `closed` 落定之后才失败。
	 * 从此之后拒绝新调用：分页读取不得在后端关闭期间开始它的下一页。
	 */
	async close(context: Context): Promise<void> {
		this.#closing = true;
		await Promise.allSettled([...this.#underway]);
		return this.#storage.close(context);
	}

	/**
	 * 在守卫之下运行一个后端调用。`read` 是读取操作的 context；`commit()` 与 `mintId()` 不传它，因此它们的
	 * 错误绝无豁免：一旦批次被准入，它是否已提交就不得而知。当另一个调用使 Session 失败时，仍在途的调用
	 * 也以 `SessionFailed` 结束——无论它返回什么：它读过写过的一切都不再被使用。
	 */
	async #call<T>(read: Context | undefined, run: () => Promise<T>): Promise<T> {
		this.#assertHealthy();
		if (this.#closing) throw new Error("Session is closed");
		let result: T;
		// 用 async 包装，因此同步抛错的后端同样被守卫覆盖。
		const call = (async () => run())();
		this.#underway.add(call);
		try {
			result = await call;
		} catch (error) {
			this.#assertHealthy();
			// 无效读取、或调用方已取消的读取，说明不了 Storage 的问题；它只让那一次调用失败。
			const exempt =
				read !== undefined && (error instanceof StorageRequestError || read.abortSignal?.aborted === true);
			if (!exempt) this.#latch.fail(error);
			throw error;
		} finally {
			this.#underway.delete(call);
		}
		this.#assertHealthy();
		return result;
	}

	#assertHealthy(): void {
		const failure = this.#latch.failure;
		if (failure !== undefined) throw new SessionFailed(failure.error);
	}
}
