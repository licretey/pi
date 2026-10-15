import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type CommitPublication,
	type ConversationId,
	type DocumentAddress,
	type DocumentCommitChange,
	type DocumentId,
	type DocumentPoint,
	type DocumentRecord,
	type Id,
	MemoryStorage,
	type Seq,
	type StorageWrite,
} from "@earendil-works/pi-durable";
import { SessionImpl } from "../src/session/session.ts";

export const context: Context = BACKGROUND_CONTEXT;

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** 暂停调用直到放行，并在第一个调用被暂停时发出通知的门闩。 */
export type Gate = {
	readonly entered: Promise<void>;
	release(): void;
};

/** 可观察提交、可拦截调用并可注入提交失败的内存存储。 */
export class ControlledStorage extends MemoryStorage {
	/** Session 接受的原始借用批次。 */
	readonly admittedCommits: (readonly StorageWrite[])[] = [];
	/** 用于值断言的脱离引用批次。 */
	readonly commits: (readonly StorageWrite[])[] = [];
	mintCount = 0;
	documentReadCount = 0;
	#commitGate: { gate: Deferred; entered: Deferred } | undefined;
	#findGate: { gate: Deferred; entered: Deferred } | undefined;
	#commitFailure: Error | undefined;

	holdCommits(): Gate {
		const held = { gate: deferred(), entered: deferred() };
		this.#commitGate = held;
		return { entered: held.entered.promise, release: () => this.#release("commit", held) };
	}

	holdFindDocument(): Gate {
		const held = { gate: deferred(), entered: deferred() };
		this.#findGate = held;
		return { entered: held.entered.promise, release: () => this.#release("find", held) };
	}

	/** 模拟被拦截的提交期间发生崩溃：该提交不会写入存储，后续提交仍可继续。 */
	crash(): void {
		this.#commitGate = undefined;
	}

	failNextCommit(error: Error): void {
		this.#commitFailure = error;
	}

	/** 在 `close()` 后重新打开存储，模拟新进程重新打开同一数据库，并保留所有已提交记录。 */
	reopen(): this {
		(this as unknown as { closed: boolean }).closed = false;
		return this;
	}

	#release(kind: "commit" | "find", held: { gate: Deferred }): void {
		if (kind === "commit" && this.#commitGate === held) this.#commitGate = undefined;
		if (kind === "find" && this.#findGate === held) this.#findGate = undefined;
		held.gate.resolve();
	}

	override async commit(writes: readonly StorageWrite[], commitContext: Context): Promise<Seq> {
		this.admittedCommits.push(writes);
		this.commits.push(structuredClone(writes));
		const held = this.#commitGate;
		if (held !== undefined) {
			held.entered.resolve();
			await held.gate.promise;
		}
		const failure = this.#commitFailure;
		if (failure !== undefined) {
			this.#commitFailure = undefined;
			throw failure;
		}
		return super.commit(writes, commitContext);
	}

	override mintId<I extends Id<string>>(): Promise<I> {
		this.mintCount++;
		return super.mintId<I>();
	}

	override document(id: DocumentId, at: DocumentPoint, callContext: Context) {
		this.documentReadCount++;
		return super.document(id, at, callContext);
	}

	override async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		callContext: Context,
	): Promise<DocumentRecord | undefined> {
		const held = this.#findGate;
		if (held !== undefined) {
			held.entered.resolve();
			await held.gate.promise;
		}
		return super.findDocument(address, at, callContext);
	}
}

/** Session 内核、受控存储以及每次已提交的发布记录。 */
export function openTestSession(): {
	readonly storage: ControlledStorage;
	readonly session: SessionImpl;
	readonly publications: CommitPublication[];
} {
	const storage = new ControlledStorage();
	const session = new SessionImpl(storage);
	const publications: CommitPublication[] = [];
	session.subscribeCommits((publication) => {
		publications.push(publication);
	});
	return { storage, session, publications };
}

export function documentChanges(
	publication: CommitPublication,
): readonly Extract<DocumentCommitChange, { readonly type: "document" }>[] {
	return publication.changes.filter(
		(change): change is Extract<DocumentCommitChange, { readonly type: "document" }> => change.type === "document",
	);
}

export function documentCopyChanges(
	publication: CommitPublication,
): readonly Extract<DocumentCommitChange, { readonly type: "document.copy" }>[] {
	return publication.changes.filter(
		(change): change is Extract<DocumentCommitChange, { readonly type: "document.copy" }> =>
			change.type === "document.copy",
	);
}

/** 创建一个会话并返回其 ID。 */
export async function createConversation(session: SessionImpl): Promise<ConversationId> {
	return session.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, context);
}

/** 等待待处理的微任务及一轮宏任务执行完毕后兑现。 */
export function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
