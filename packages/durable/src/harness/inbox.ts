import type { Draft, JsonRepresentation } from "@earendil-works/chord";
import { defineDoc } from "../documents.ts";
import { UserEntry } from "../entries.ts";
import type { ConversationId, EntryDraft, EntryId, JsonObject, SubmissionId, Tx } from "../types.ts";
import type { QueueMode, Settings, UserInput } from "./types.ts";

/** 一条排队的提交请求：一次运行的用户输入，或一次被动的条目写入。 */
export type InboxItem =
	| { id: SubmissionId; mode: "steer" | "followUp"; content: JsonRepresentation<UserInput> }
	/** `entry` 是一个 `EntryDraft`，以纯 JSON 存储。 */
	| { id: SubmissionId; mode: "write"; entry: JsonObject };

/** 内建队列：一个对话中等待边界的提交请求，按 ID 排序。 */
export type InboxState = { items: InboxItem[] };

export const InboxDoc = defineDoc<InboxState>({
	kind: "pi.inbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
	checkpointWhen: (value) => value.items.length === 0,
});

/** 边界在会话线（Session line）上读取的设置。 */
export type QueueModes = Pick<Settings, "steeringMode" | "followUpMode">;

/** 边界在提交的第一次表写入之前读取的信息，以及它目前见过的最新 head。 */
export type Boundary = {
	readonly conversationId: ConversationId;
	readonly inbox: Draft<InboxState>;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	/** 活动区间的起点，即最新 head 标记的 `head`；随本提交中写入的 head 前移。 */
	head: EntryId | undefined;
};

/** 被选中的用户项（按 ID 排序），以及是否放置了一次 `head: "self"` 写入（即重置）。 */
export type BoundaryResult = { readonly users: SubmissionId[]; readonly reset: boolean };

/**
 * 读取边界所需的信息。表读取必须先于提交的第一次表写入，因此调用方要在自己提交的开头准备边界。
 */
export async function prepareBoundary(tx: Tx, conversationId: ConversationId, modes: QueueModes): Promise<Boundary> {
	const head = (await tx.latestHeadMarker(conversationId))?.head;
	const inbox = await tx.doc(InboxDoc, conversationId);
	return {
		conversationId,
		inbox,
		steeringMode: modes.steeringMode,
		followUpMode: modes.followUpMode,
		head,
	};
}

/**
 * 放置边界选中的排队项（规范 §6）：全部写入项，第一个或全部 steer，以及在 `final` 时的第一个或全部
 * follow-up。被选中的重置会把 `postTools` 边界变为 `final`。写入项先放置、用户项随后，各自按 ID 序，
 * 因此排在重置之前的用户项会在新上下文中运行。写入项的 head 若指向活动区间之前的条目（包括本提交中
 * 更早开始的区间），即为过期（stale）。被选中的与过期的项都按位置移除。
 */
export async function applyBoundary(
	tx: Tx,
	boundary: Boundary,
	at: "postTools" | "final",
	now: number,
): Promise<BoundaryResult> {
	const { conversationId, inbox } = boundary;
	const items = inbox.items;
	const reset = items.some((item) => item.mode === "write" && item.entry.head === "self");
	const final = at === "final" || reset;
	const pick = (mode: "steer" | "followUp", queueMode: QueueMode): number[] => {
		const indexes = items.flatMap((item, index) => (item.mode === mode ? [index] : []));
		return queueMode === "all" ? indexes : indexes.slice(0, 1);
	};
	const writes = items.flatMap((item, index) => (item.mode === "write" ? [index] : []));
	const users = [...pick("steer", boundary.steeringMode), ...(final ? pick("followUp", boundary.followUpMode) : [])];
	users.sort((a, b) => a - b);

	// `appendEntry()` 会复制草稿的值；这些项只在之后才被移除。
	for (const index of writes) {
		const item = items[index] as Draft<Extract<InboxItem, { mode: "write" }>>;
		const draft = item.entry as unknown as EntryDraft;
		if (isStale(boundary, draft)) {
			tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" });
			continue;
		}
		const entry = await tx.appendEntry(conversationId, draft);
		if (draft.head !== undefined) boundary.head = draft.head === "self" ? entry.id : draft.head;
		tx.placeSubmission(item.id, entry.id);
	}
	const placed: SubmissionId[] = [];
	for (const index of users) {
		const item = items[index] as Draft<Extract<InboxItem, { mode: "steer" | "followUp" }>>;
		const message = { role: "user", content: item.content as UserInput, timestamp: now } as const;
		const entry = await tx.appendEntry(UserEntry, conversationId, { model: [message] });
		tx.placeSubmission(item.id, entry.id);
		placed.push(item.id);
	}
	const removed = [...writes, ...users].sort((a, b) => b - a);
	for (const index of removed) items.splice(index, 1);
	return { users: placed, reset };
}

/** head 写入是否指向活动区间之前的条目——若是，放置它会把已被裁掉的历史带回来。 */
export function isStale(boundary: Boundary, entry: EntryDraft): boolean {
	return typeof entry.head === "number" && boundary.head !== undefined && entry.head < boundary.head;
}

/** 移除被撤回提交请求的队列项；提交请求由调用方结算。 */
export async function removeInboxItem(tx: Tx, conversationId: ConversationId, id: SubmissionId): Promise<void> {
	const items = (await tx.doc(InboxDoc, conversationId)).items;
	const index = items.findIndex((item) => item.id === id);
	if (index >= 0) items.splice(index, 1);
}

/**
 * 撤回一个对话的所有排队输入，正如 `Conversation.abort()` 与中止级联所做的：每一项都以 `aborted` 结算为
 * `unanswered` 并离开收件箱；排队的写入项保留下来等待之后放置。
 */
export async function withdrawQueuedInputs(tx: Tx, conversationId: ConversationId): Promise<void> {
	const items = (await tx.doc(InboxDoc, conversationId)).items;
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index]!;
		if (item.mode === "write") continue;
		tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
		items.splice(index, 1);
	}
}
