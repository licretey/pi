import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { idFromNumber } from "../ids.ts";
import type { SessionImpl } from "../session/session.ts";
import type { ContextEdit, ConversationId, Cursor, EntryId, EntryQuery, EntryRecord, Storage } from "../types.ts";
import type { ContextView } from "./types.ts";

const SCAN_PAGE_SIZE = 256;
const EXCLUDED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set(["aborted", "error", "deferred"]);
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";

/** 确定一个已提交上下文区间的 head 标记与最新可见条目。 */
export type ContextBounds = {
	readonly head: (EntryRecord & { readonly head: EntryId }) | undefined;
	readonly tail: EntryId;
};

/**
 * 用两次 O(1) 读取捕获当前上下文的边界，或在可见条目 `at` 处截断的上下文边界。请在会话线（Session line）上
 * 运行它；尾部及更早的条目不可变，因此 `deriveContext()` 随后可以脱离该线扫描它们。
 */
export async function captureContextBounds(
	storage: Storage,
	conversationId: ConversationId,
	context: Context,
	at?: EntryId,
): Promise<ContextBounds | undefined> {
	let tail: EntryId | undefined;
	if (at === undefined) {
		tail = (await storage.scanEntries({ conversationId }, 1, undefined, context)).items[0]?.id;
		if (tail === undefined) return undefined;
	} else {
		if ((await storage.entry(conversationId, at, context)) === undefined) {
			throw new Error(`Entry ${at} is not visible from conversation ${conversationId}`);
		}
		tail = at;
	}
	return { head: await storage.findLatestHeadMarker(conversationId, tail, context), tail };
}

/**
 * 一次上下文读取：它扫描到的可见条目——从 head 标记的 head（或转录起点）直到 `bounds.tail`，最早的在前，
 * 以及由它们派生的视图。尾部及更早的条目永不变化，因此之后使用相同 head 标记的读取就能同时扩展两者。
 */
export type ContextRange = {
	readonly bounds: ContextBounds;
	readonly entries: readonly EntryRecord[];
	readonly view: ContextView;
	/** `entries` 中各编辑的目标。 */
	readonly edited: ReadonlySet<EntryId>;
	/**
	 * `view.messages` 中最后一条助手消息之前的贡献消息部分。工具结果会在直到下一条助手消息为止的消息内
	 * 排序，因此更晚的条目无法再改变这些内容。
	 */
	readonly settled: readonly Message[];
	/** 从最后一条助手消息开始的贡献消息，尚未做工具结果排序。 */
	readonly open: readonly Message[];
};

/**
 * `readContext()` 的复用版本：`previous` 是同一对话更早的一次区间，head 标记相同则只扫描其尾部之后的条目。
 * 返回视图与要传给下一次读取的区间。区间会比读取活得更久，所以它的条目会像 `MemoryStorage` 记录一样被
 * 冻结，返回的视图也拥有自己的数组。
 */
export async function readContextFrom(
	session: SessionImpl,
	storage: Storage,
	conversationId: ConversationId,
	context: Context,
	at: EntryId | undefined,
	previous: ContextRange | undefined,
): Promise<{ readonly view: ContextView; readonly range: ContextRange | undefined }> {
	const bounds = await session.readOnLine(() => captureContextBounds(storage, conversationId, context, at));
	if (bounds === undefined) return { view: emptyView(), range: undefined };
	freezeJson(bounds.head);
	let range: ContextRange;
	if (previous === undefined || previous.bounds.head?.id !== bounds.head?.id) {
		range = deriveRange(bounds, freezeJson(await scanRange(storage, conversationId, rangeQuery(bounds), context)));
	} else if (bounds.tail === previous.bounds.tail) {
		range = previous;
	} else if (bounds.tail < previous.bounds.tail) {
		range = deriveRange(
			bounds,
			previous.entries.filter((entry) => entry.id <= bounds.tail),
		);
	} else {
		const minEntryId = idFromNumber<EntryId>(previous.bounds.tail + 1);
		const added = await scanRange(storage, conversationId, { minEntryId, maxEntryId: bounds.tail }, context);
		range = extendRange(previous, bounds, freezeJson(added));
	}
	const { view } = range;
	return {
		view: {
			...view,
			entries: [...view.entries],
			contributions: [...view.contributions],
			messages: [...view.messages],
		},
		range,
	};
}

/** 单个对话的已提交上下文：边界在会话线上捕获，条目在脱离会话线之后派生。 */
export async function readContext(
	session: SessionImpl,
	storage: Storage,
	conversationId: ConversationId,
	context: Context,
	at?: EntryId,
): Promise<ContextView> {
	const bounds = await session.readOnLine(() => captureContextBounds(storage, conversationId, context, at));
	return deriveContext(storage, conversationId, bounds, context);
}

/**
 * 在捕获的边界内派生一个对话的活动转录与模型上下文。
 *
 * H = 最新的可见 head 标记；区间从 `H.head`（或转录起点）直到尾部。对每个目标而言，区间内最新的编辑胜出。
 * context 条目为 H 及区间内所有非 head 条目。
 */
export async function deriveContext(
	storage: Storage,
	conversationId: ConversationId,
	bounds: ContextBounds | undefined,
	context: Context,
): Promise<ContextView> {
	if (bounds === undefined) return emptyView();
	return deriveRange(bounds, await scanRange(storage, conversationId, rangeQuery(bounds), context)).view;
}

function emptyView(): ContextView {
	return { head: undefined, entries: [], contributions: [], messages: [] };
}

/** 从 `bounds` 内扫描到的条目派生上下文视图。 */
function deriveRange(bounds: ContextBounds, entries: readonly EntryRecord[]): ContextRange {
	const edits = new Map<EntryId, ContextEdit>();
	// 区间内每个条目的编辑都要计入，包括被 `selectActive()` 丢弃的较旧 head 标记。
	for (const entry of entries) for (const edit of entry.edits ?? []) edits.set(edit.target, edit);
	const active = selectActive(bounds.head, entries);
	const contributions = active.map((entry) => contribute(entry, edits.get(entry.id)));
	const { settled, open } = settle([], contributions.flat());
	const messages = leadWithSystem([...settled, ...orderToolResults(open)]);
	const view = { head: bounds.head, entries: active, contributions, messages };
	return { bounds, entries, view, edited: new Set(edits.keys()), settled, open };
}

/**
 * 在相同 head 标记下，用尾部之后的条目 `added` 扩展 `previous`：只有它们的贡献消息和 open 消息需要派生。
 * 新增的编辑可能改变更早的条目，因此那种情况下会重新派生整个区间。
 */
function extendRange(previous: ContextRange, bounds: ContextBounds, added: readonly EntryRecord[]): ContextRange {
	const entries = [...previous.entries, ...added];
	if (added.some((entry) => entry.edits !== undefined || entry.head !== undefined || previous.edited.has(entry.id))) {
		return deriveRange(bounds, entries);
	}
	const contributions = added.map((entry) => contribute(entry, undefined));
	const { settled, open } = settle(previous.settled, [...previous.open, ...contributions.flat()]);
	const view = {
		head: bounds.head,
		entries: [...previous.view.entries, ...added],
		contributions: [...previous.view.contributions, ...contributions],
		messages: leadWithSystem([...settled, ...orderToolResults(open)]),
	};
	return { bounds, entries, view, edited: previous.edited, settled, open };
}

/**
 * 把一个只有用户消息在其前面的 system 消息移到最前面。一次运行的输入在 generation 渲染系统提示之前就已提交，
 * 因此转录（或压缩、重置之后的区间）会以用户消息开头，随后才是基线 system 消息。提供方只把位于开头的
 * system 消息当作初始提示与工具集；若缺少它，之后的工具变更会改写请求的工具列表，使整段提示缓存失效。
 */
function leadWithSystem(messages: Message[]): Message[] {
	const index = messages.findIndex((message) => message.role !== "user");
	if (index <= 0 || messages[index]!.role !== "system") return messages;
	return [messages[index]!, ...messages.slice(0, index), ...messages.slice(index + 1)];
}

/** 单个活动条目在套用其编辑并剔除被排除停止原因后的模型消息，尚未做工具结果排序。 */
function contribute(entry: EntryRecord, edit: ContextEdit | undefined): readonly Message[] {
	if (edit?.action === "omit") return Object.freeze([]);
	const contributed = edit?.action === "replace" ? edit.messages : (entry.model ?? []);
	return Object.freeze(
		contributed.filter((message) => message.role !== "assistant" || !EXCLUDED_STOP_REASONS.has(message.stopReason)),
	);
}

/** 被 `freezeJson()` 连同其内容整体冻结的对象。浅冻结也会让 `Object.isFrozen()` 成立，所以需要单独记录。 */
const deeplyFrozen = new WeakSet<object>();

/** 冻结一个 JSON 值及其内部的一切。 */
function freezeJson<T>(value: T): T {
	if (value === null || typeof value !== "object" || deeplyFrozen.has(value)) return value;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
	deeplyFrozen.add(value);
	return value;
}

/**
 * 把 `open` 中最后一条助手消息之前的有序消息移入 `settled`。当每个较后的部分都以助手消息开头时，
 * 一个序列的 `orderToolResults()` 等于对其各部分结果的拼接。
 */
function settle(
	settled: readonly Message[],
	open: readonly Message[],
): { readonly settled: readonly Message[]; readonly open: readonly Message[] } {
	const last = open.findLastIndex((message) => message.role === "assistant");
	if (last <= 0) return { settled, open };
	return { settled: [...settled, ...orderToolResults(open.slice(0, last))], open: open.slice(last) };
}

/** 捕获边界内的原始活动条目，不派生模型上下文。 */
export async function activeEntries(
	storage: Storage,
	conversationId: ConversationId,
	bounds: ContextBounds | undefined,
	context: Context,
): Promise<readonly EntryRecord[]> {
	if (bounds === undefined) return [];
	return selectActive(bounds.head, await scanRange(storage, conversationId, rangeQuery(bounds), context));
}

/** `bounds` 的可见区间：从 head 标记的 head（或转录起点）直到尾部。 */
function rangeQuery(bounds: ContextBounds): Omit<EntryQuery, "conversationId"> {
	const head = bounds.head;
	return head === undefined ? { maxEntryId: bounds.tail } : { minEntryId: head.head, maxEntryId: bounds.tail };
}

/** `range` 内的可见条目，最早的在前。 */
async function scanRange(
	storage: Storage,
	conversationId: ConversationId,
	range: Omit<EntryQuery, "conversationId">,
	context: Context,
): Promise<EntryRecord[]> {
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries({ conversationId, ...range }, SCAN_PAGE_SIZE, cursor, context);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return entries.reverse();
}

/** head 标记加上区间中的非 head 条目；没有标记时为整个区间。 */
function selectActive(head: ContextBounds["head"], range: readonly EntryRecord[]): readonly EntryRecord[] {
	return head === undefined ? range : [head, ...range.filter((entry) => entry.head === undefined)];
}

/**
 * 把每条助手消息的工具结果按调用顺序放到它紧后面。结果取自下一条助手消息之前的消息；缺失的结果会被
 * 合成补齐，无法配对的结果会被丢弃。
 */
export function orderToolResults(messages: readonly Message[]): Message[] {
	const ordered: Message[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "toolResult") continue;
		ordered.push(message);
		if (message.role !== "assistant") continue;
		const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
		if (calls.length === 0) continue;
		const results = new Map<string, number>();
		for (let next = index + 1; next < messages.length && messages[next]!.role !== "assistant"; next++) {
			const candidate = messages[next]!;
			if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) {
				results.set(candidate.toolCallId, next);
			}
		}
		for (const call of calls) {
			const resultIndex = results.get(call.id);
			ordered.push(resultIndex === undefined ? missingResult(call, message.timestamp) : messages[resultIndex]!);
		}
	}
	return ordered;
}

function missingResult(call: ToolCall, timestamp: number): ToolResultMessage {
	return freezeJson({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: MISSING_RESULT_TEXT }],
		isError: true,
		details: { reason: "missing_result" },
		timestamp,
	});
}
