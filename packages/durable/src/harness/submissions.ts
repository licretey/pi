import { type Context, copyJson, type JsonRepresentation } from "@earendil-works/chord";
import { UserEntry } from "../entries.ts";
import { ConversationBusy } from "../errors.ts";
import type { SessionImpl } from "../session/session.ts";
import type {
	CommitPublication,
	ConversationId,
	JsonObject,
	Storage,
	SubmissionId,
	SubmissionRecord,
	Tx,
} from "../types.ts";
import { startRun } from "./generation.ts";
import { applyBoundary, InboxDoc, isStale, prepareBoundary, type QueueModes, removeInboxItem } from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import type { SettledSubmissionRecord, Submission, SubmissionDraft, UserInput } from "./types.ts";
import { closedError, Waiters } from "./util.ts";

type AbortResult = "aborted" | "already_placed" | "settled";

/** 管理一个 Harness 的持久化提交接纳、等待和撤回。 */
export class Submissions {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #now: () => number;
	/** 每次接纳提交时都在 Session 顺序线上读取。 */
	readonly #queueModes: () => QueueModes;
	/** 启用任务调度；提交或等待操作会请求调度器推进任务。 */
	readonly #resume: () => void;
	readonly #waiters = new Waiters<SubmissionId, SettledSubmissionRecord>();
	#closed = false;

	constructor(
		session: SessionImpl,
		storage: Storage,
		now: () => number,
		queueModes: () => QueueModes,
		resume: () => void,
	) {
		this.#session = session;
		this.#storage = storage;
		this.#now = now;
		this.#queueModes = queueModes;
		this.#resume = resume;
		session.observeCommits((publication) => this.#observe(publication));
		session.subscribeClose(() => {
			this.#closed = true;
			this.#waiters.rejectAll(closedError(this.#session));
		});
	}

	/** 在一次提交中接纳请求；参见 `admitSubmission()`。 */
	async submit(conversationId: ConversationId, draft: SubmissionDraft, context: Context): Promise<Submission> {
		this.#resume();
		const id = await this.#session.commitWith(
			(tx) => admitSubmission(tx, conversationId, draft, this.#now(), this.#queueModes()),
			context,
		);
		return new SubmissionHandle(id, this);
	}

	/** 返回现有提交的句柄；提交不存在时返回 `undefined`。 */
	async get(id: SubmissionId, context: Context): Promise<Submission | undefined> {
		const record = await this.#session.readOnLine(() => this.#storage.submission(id, context));
		return record === undefined ? undefined : new SubmissionHandle(record.id, this);
	}

	async status(id: SubmissionId, context: Context): Promise<SubmissionRecord> {
		const record = await this.#session.readOnLine(() => this.#storage.submission(id, context));
		if (record === undefined) throw new Error(`Submission ${id} does not exist`);
		return record;
	}

	async wait(id: SubmissionId, context: Context): Promise<SettledSubmissionRecord> {
		this.#resume();
		// 在同一顺序线上检查并注册，避免检查与注册之间错过结算发布。
		const found = await this.#session.readOnLine(async () => {
			const record = await this.#storage.submission(id, context);
			if (record === undefined) throw new Error(`Submission ${id} does not exist`);
			if (isSettled(record)) return { promise: Promise.resolve(record) };
			// 关闭时会同步拒绝已注册的等待者，而且读取过程中也可能开始关闭。
			if (this.#closed) throw closedError(this.#session);
			return { promise: this.#waiters.add(id, context) };
		});
		return found.promise;
	}

	/** 撤回排队中的提交并移除收件箱条目；已放置的输入和已结算的提交会返回对应状态。 */
	abort(id: SubmissionId, context: Context, conversationId?: ConversationId): Promise<AbortResult | "not_found"> {
		return this.#session.commitWith(async (tx) => {
			const record = await tx.submission(id);
			if (record === undefined || (conversationId !== undefined && record.conversationId !== conversationId)) {
				return "not_found";
			}
			if (record.status === "queued") {
				tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
				await removeInboxItem(tx, record.conversationId, id);
				return "aborted";
			}
			return record.status === "placed" ? "already_placed" : "settled";
		}, context);
	}

	#observe(publication: CommitPublication): void {
		for (const change of publication.changes) {
			if (change.type !== "submission" || !isSettled(change.value)) continue;
			this.#waiters.resolve(change.value.id, change.value);
		}
	}
}

class SubmissionHandle implements Submission {
	readonly id: SubmissionId;
	readonly #submissions: Submissions;

	constructor(id: SubmissionId, submissions: Submissions) {
		this.id = id;
		this.#submissions = submissions;
	}

	status(context: Context): Promise<SubmissionRecord> {
		return this.#submissions.status(this.id, context);
	}

	wait(context: Context): Promise<SettledSubmissionRecord> {
		return this.#submissions.wait(this.id, context);
	}

	async abort(context: Context): Promise<AbortResult> {
		const result = await this.#submissions.abort(this.id, context);
		if (result === "not_found") throw new Error(`Submission ${this.id} does not exist`);
		return result;
	}
}

function isSettled(record: SubmissionRecord): record is SettledSubmissionRecord {
	return record.status === "done" || record.status === "unanswered";
}

/**
 * 在一次提交中接纳请求（规范 §6）；`Conversation.submit()` 和由对话拥有的压缩任务共用此逻辑。已知的 request ID 会直接返回现有提交，
 * 不再写入。繁忙的对话会将请求排入 `pi.inbox`；若输入指定 `whenBusy: "reject"`，则抛出 `ConversationBusy`。
 * 空闲对话已有排队条目时，会将新请求排在其后并执行最终边界处理。否则，空闲输入会放置 user 记录并启动运行；
 * 空闲写入会追加记录并结算为 `done`，若其 head 早于活动范围则结算为 `stale`。
 */
export async function admitSubmission(
	tx: Tx,
	conversationId: ConversationId,
	draft: SubmissionDraft,
	now: number,
	queueModes: QueueModes,
): Promise<SubmissionId> {
	if (draft.requestId !== undefined) {
		const existing = await tx.submissionByRequest(conversationId, draft.requestId);
		if (existing !== undefined) {
			if (existing.type !== draft.type) {
				throw new Error(`Request ${draft.requestId} already identifies a submission of type ${existing.type}`);
			}
			return existing.id;
		}
	}
	const live = await tx.doc(LiveDoc, conversationId);
	const busy = live.run !== undefined;
	if (busy && draft.type === "input" && draft.whenBusy === "reject") throw new ConversationBusy(conversationId);
	const requestId = draft.requestId === undefined ? {} : { requestId: draft.requestId };
	// 边界处理需要读取提交表，因此必须在首次写表之前准备；繁忙的对话无需准备边界。
	const boundary = busy ? undefined : await prepareBoundary(tx, conversationId, queueModes);
	if (boundary === undefined || boundary.inbox.items.length > 0) {
		const { id } = await tx.createSubmission({
			conversationId,
			...requestId,
			type: draft.type,
			status: "queued",
		});
		// 宿主可能将可选字段保留为 `undefined`；草稿必须符合严格 JSON。
		const value = copyJson(draft.type === "write" ? draft.entry : draft.content, {
			omitUndefinedProperties: true,
		});
		const items = (boundary?.inbox ?? (await tx.doc(InboxDoc, conversationId))).items;
		if (draft.type === "write") items.push({ id, mode: "write", entry: value as JsonObject });
		else {
			const mode = draft.whenBusy === "steer" ? "steer" : "followUp";
			items.push({ id, mode, content: value as JsonRepresentation<UserInput> });
		}
		if (boundary === undefined) return id;
		const { users } = await applyBoundary(tx, boundary, "final", now);
		if (users.length > 0) await startRun(tx, conversationId, live, users);
		return id;
	}
	if (draft.type === "write") {
		if (isStale(boundary, draft.entry)) {
			const stale = { status: "unanswered", reason: "stale" } as const;
			return (await tx.createSubmission({ conversationId, ...requestId, type: "write", ...stale })).id;
		}
		const entry = await tx.appendEntry(conversationId, draft.entry);
		const write = { conversationId, ...requestId, type: "write", status: "done", entry: entry.id } as const;
		return (await tx.createSubmission(write)).id;
	}
	const message = { role: "user", content: draft.content, timestamp: now } as const;
	const entry = await tx.appendEntry(UserEntry, conversationId, { model: [message] });
	const input = { conversationId, ...requestId, type: "input", status: "placed", entry: entry.id } as const;
	const { id } = await tx.createSubmission(input);
	await startRun(tx, conversationId, live, [id]);
	return id;
}
