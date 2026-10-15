import type { Context, JsonValue } from "@earendil-works/chord";
import type { Op, Path } from "@earendil-works/chord/delta";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { CommittedWatch } from "../session/observation.ts";
import type {
	CommitChange,
	CommitPublication,
	ConversationId,
	EntryRecord,
	JsonObject,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	WatchEnd,
} from "../types.ts";
import { AgentDoc } from "./agent.ts";
import type { InboxItem, InboxState } from "./inbox.ts";
import type { CompactionStatus, LiveState, NestedToolSlot, ToolSlot } from "./live.ts";
import { NestedResultDoc } from "./tool.ts";
import type { AgentState, CompactionReason, Harness, NestedToolExecutionResult, ToolDiagnostic } from "./types.ts";
import { UsageDoc, type UsageState } from "./usage.ts";
import { scanAll } from "./util.ts";
import { type ConversationView, conversationViews } from "./view.ts";

type Block = AssistantMessage["content"][number];
type QueuedItem = { id: SubmissionId; mode: InboxItem["mode"] };

/** 在途 assistant 消息的一次变化，相对于该消息本身。 */
export type MessageChange =
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; block: Block }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_delta"; contentIndex: number; path: readonly (string | number)[]; delta: string }
	| { type: "block"; contentIndex: number; block: Block }
	| { type: "message"; message: AssistantMessage };

export type SnapshotEvent = {
	type: "snapshot";
	entries: readonly EntryRecord[];
	run?: { inputs: readonly SubmissionId[] };
	/** 当前的 generation 尝试：它的在途 partial、重试退避，或 deferred 轮询。 */
	generation?: {
		attempt: number;
		message?: AssistantMessage;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools: readonly ToolSlot[];
	/** `pi.live.nestedTools`：运行中工具调用的嵌套调用。 */
	nestedTools: readonly NestedToolSlot[];
	/** `pi.live.compactions`：存活的 compaction 及其 attempt 与重试退避。 */
	compactions: readonly CompactionStatus[];
	inbox: readonly QueuedItem[];
	/** `pi.agent`；缺失时为 `{}`。 */
	agent: AgentState;
	usage: UsageState;
};

/** 实验性的 agent 事件，形状与 coding agent 的 session 事件一致（spec §9.4）。 */
export type AgentEvent =
	| SnapshotEvent
	| { type: "run_start"; inputs: readonly SubmissionId[] }
	| { type: "run_end"; inputs: readonly SubmissionId[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: Message }
	/** `usage` 是 partial 当前的用量，与 coding agent 的 JSON 模式相同。 */
	| { type: "message_update"; usage: Usage; changes: readonly MessageChange[] }
	| { type: "message_end"; entry: EntryRecord }
	| ({ type: "tool_execution_start"; args: JsonObject } & ToolEventCall)
	| ({
			type: "tool_execution_update";
			/** 先做头部裁剪再追加保留的窗口，或整体替换。 */
			output?: { trimStart?: number; append?: string } | { set: string };
			details?: JsonValue;
			diagnostics?: readonly ToolDiagnostic[];
	  } & ToolEventCall)
	/**
	 * 模型发起的调用以其结果的 `entry` 结束，嵌套调用以其 `result` 结束。工具任务被故障化或孤儿化，
	 * 或调用的 slot 未完成就离开了 `pi.live`——run 结束，或父调用先落定——两者都不出现。
	 */
	| ({ type: "tool_execution_end"; entry?: EntryRecord; result?: NestedToolExecutionResult } & ToolEventCall)
	| { type: "inbox_update"; items: readonly QueuedItem[] }
	| { type: "submission"; record: SubmissionRecord }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "deferred_poll"; pollAt: number }
	| { type: "entry_appended"; entry: EntryRecord }
	| { type: "agent_changed"; agent: AgentState }
	| { type: "usage_changed"; usage: UsageState }
	| { type: "task_failed"; taskId: TaskId; kind: string; message: string }
	| { type: "compaction_start"; taskId: TaskId; reason: CompactionReason; blocking: boolean }
	/** 任务的回执说明它是否产生了 summary；summary entry 有自己的事件。 */
	| { type: "compaction_end"; taskId: TaskId; reason: CompactionReason };

/**
 * 工具事件针对哪个调用。`toolCallId` 是该调用在 transcript 与工具事件中的 ID：模型发起的调用用 provider 的
 * ID，嵌套调用用 `<父调用 ID>/<key>`。用它匹配事件，不要解析它。`taskId` 是该调用的工具任务；
 * 从未拿到任务的调用（未被提供，或顺序轮中未启动）没有此字段。
 * 嵌套调用还会按 call ID 与工具任务指明发起它的调用。
 */
export type ToolEventCall = {
	toolCallId: string;
	toolName: string;
	taskId?: TaskId;
	parentToolCallId?: string;
	parentTaskId?: TaskId;
};

/** 单个 conversation 事件批次的串行化流，每个 commit 一批。 */
export interface AgentEventStream {
	/** 附着时的 `snapshot` 事件。 */
	readonly snapshot: SnapshotEvent;
	start(listener: (events: readonly AgentEvent[], context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
	readonly closed: Promise<WatchEnd>;
}

/** 事件从 view 中读取的类型化部分。 */
type Parts = {
	live: LiveState;
	inbox: InboxState | undefined;
	agent: AgentState | undefined;
	usage: UsageState | undefined;
};

function parts(view: ConversationView): Parts {
	return {
		live: (view.docs["pi.live"] ?? {}) as LiveState,
		inbox: view.docs["pi.inbox"] as InboxState | undefined,
		agent: view.docs["pi.agent"] as AgentState | undefined,
		usage: view.docs["pi.usage"] as UsageState | undefined,
	};
}

function snapshotOf(view: ConversationView): SnapshotEvent {
	const { live, inbox, agent, usage } = parts(view);
	return {
		type: "snapshot",
		entries: view.entries,
		...(live.run === undefined ? {} : { run: { inputs: live.run.inputs } }),
		...(live.generation === undefined ? {} : { generation: live.generation as SnapshotEvent["generation"] }),
		tools: live.tools ?? [],
		nestedTools: live.nestedTools ?? [],
		compactions: live.compactions ?? [],
		inbox: queued(inbox),
		agent: agent ?? AgentDoc.definition.initial(),
		usage: usage ?? UsageDoc.definition.initial(),
	};
}

function queued(inbox: InboxState | undefined): QueuedItem[] {
	return (inbox?.items ?? []).map((item) => ({ id: item.id, mode: item.mode }));
}

/**
 * 实验性功能：附着到单个 conversation 的 agent 事件（spec §9.4）。快照与后续 commit 的注册在 Session 线上
 * 原子地捕获；溢出时用一个快照替换未投递的批次。
 */
export async function watchEvents(
	harness: Harness,
	conversationId: ConversationId,
	context: Context,
): Promise<AgentEventStream> {
	const views = conversationViews(harness);
	let watch!: CommittedWatch<readonly AgentEvent[]>;
	let snapshot!: SnapshotEvent;
	await views.attach(
		conversationId,
		async (initial, release, storage) => {
			// 被持有的 outcome 已终结其回合的 generation，在线上与快照一起读取。
			const query = { conversationId, kind: "pi.generation", status: "completing" } as const;
			const completing = await scanAll((cursor) => storage.scanTasks(query, 100, cursor, context));
			const held = new Set<TaskId>(completing.map((record) => record.id));
			let current = initial;
			snapshot = snapshotOf(initial);
			// 批次是 watch 的值；溢出时改为投递最新 view 的一个快照。
			watch = new CommittedWatch<readonly AgentEvent[]>(
				[],
				release,
				(error) => views.report(error),
				() => [snapshotOf(current)],
			);
			return {
				publication: (before, after, ops, publication, commitContext) => {
					current = after;
					const events = translate(conversationId, before, after, ops, publication, held);
					if (events.length > 0) watch.advance(events, [], commitContext);
				},
				closeSession: (failure) => watch.closeSession(failure),
			};
		},
		context,
	);
	// 与 watch 一样，获取时的 context 决定流的生命周期。
	const signal = context.abortSignal;
	if (signal?.aborted) {
		watch.cancel();
		throw signal.reason;
	}
	if (signal !== undefined) watch.observeCancellation(signal);
	return {
		snapshot,
		start: (listener) => watch.start((events, _ops, deliveryContext) => listener(events, deliveryContext)),
		stop: () => watch.stop(),
		closed: watch.closed,
	};
}

type TaskChange = Extract<CommitChange, { type: "task" }>;

/** `entries` 中 `callId` 对应的工具结果。 */
function resultOf(entries: readonly EntryRecord[], callId: string): EntryRecord | undefined {
	return entries.find((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult" && message.toolCallId === callId;
	});
}

/** 一次 publication 引发的全部事件，按 spec §9.4 的顺序。 */
function translate(
	conversationId: ConversationId,
	before: ConversationView,
	after: ConversationView,
	viewOps: readonly Op[],
	publication: CommitPublication,
	held: Set<TaskId>,
): AgentEvent[] {
	const entries: EntryRecord[] = [];
	const tasks = new Map<TaskId, TaskChange["value"]>();
	const submissions: SubmissionRecord[] = [];
	// 本次 commit 存储的嵌套结果，按嵌套任务 ID 索引；现在读取，因为调用方的文档可能接下来退役。
	const nestedResults = new Map<string, NestedToolExecutionResult>();
	for (const change of publication.changes) {
		if (
			change.type === "document" &&
			change.record.kind === NestedResultDoc.definition.kind &&
			change.record.key !== undefined &&
			change.value !== null &&
			change.conversationId === conversationId
		) {
			nestedResults.set(change.record.key, change.value.result as unknown as NestedToolExecutionResult);
		}
		if (change.type === "entry" && change.value.conversationId === conversationId) entries.push(change.value);
		if (change.type === "task" && change.value.conversationId === conversationId)
			tasks.set(change.value.id, change.value);
		if (change.type === "submission" && change.value.conversationId === conversationId) {
			submissions.push(change.value);
		}
	}
	if (viewOps.length === 0 && entries.length === 0 && tasks.size === 0 && submissions.length === 0) return [];
	// entry 按 ID 顺序追加；submission 记录按 commit 首次触及它们的顺序发布。
	submissions.sort((a, b) => a.id - b.id);
	const was = parts(before);
	const now = parts(after);
	const events: AgentEvent[] = [];

	// 进度：工具启动、在途消息、工具更新、重试与 deferred 状态。
	const slotsBefore = new Map((was.live.tools ?? []).map((slot) => [slot.callId, slot]));
	const slots = now.live.tools ?? [];
	const nestedBefore = new Map((was.live.nestedTools ?? []).map((slot) => [slot.taskId, slot]));
	const nested = now.live.nestedTools ?? [];
	for (const slot of [...slots, ...nested]) {
		const previous = "parentCallId" in slot ? nestedBefore.get(slot.taskId) : slotsBefore.get(slot.callId);
		if (slot.status !== "running" || previous?.status === "running") continue;
		// 嵌套 slot 携带调用实际运行所用的参数；模型发起调用的参数在其 intent checkpoint 里。
		const checkpoint = slot.taskId === undefined ? undefined : tasks.get(slot.taskId)?.state.checkpoint;
		const args =
			"parentCallId" in slot
				? slot.arguments
				: ((checkpoint as { arguments?: JsonObject } | undefined)?.arguments ?? {});
		events.push({ type: "tool_execution_start", ...callOf(slot), args });
	}
	const partialBefore = was.live.generation?.message as AssistantMessage | undefined;
	const partial = now.live.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined && partialBefore === undefined) events.push({ type: "message_start", message: partial });
	else if (partial !== undefined && partial !== partialBefore) {
		events.push({ type: "message_update", usage: partial.usage, changes: messageChanges(viewOps, partial) });
	}
	for (const [index, slot] of slots.entries()) {
		const previous = slotsBefore.get(slot.callId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(viewOps, ["tools", index], slot, previous);
		if (update === undefined) continue;
		events.push({ type: "tool_execution_update", ...callOf(slot), ...update });
	}
	for (const [index, slot] of nested.entries()) {
		const previous = nestedBefore.get(slot.taskId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(viewOps, ["nestedTools", index], slot, previous);
		if (update === undefined) continue;
		events.push({ type: "tool_execution_update", ...callOf(slot), ...update });
	}
	const generation = now.live.generation;
	const generationBefore = was.live.generation;
	if (generation?.retry !== undefined && generationBefore?.retry === undefined) {
		const { at, error } = generation.retry;
		events.push({ type: "auto_retry_start", attempt: generation.attempt, at, errorMessage: error });
	}
	if (generationBefore?.retry !== undefined && generation?.retry === undefined) {
		events.push({ type: "auto_retry_end", attempt: generationBefore.attempt });
	}
	if (generation?.deferred !== undefined && generation.deferred.pollAt !== generationBefore?.deferred?.pollAt) {
		events.push({ type: "deferred_poll", pollAt: generation.deferred.pollAt });
	}

	// 本次 commit 中结束的工具：变为 done 的 slot、创建即 done 的 slot（未被提供的调用），
	// 或因 run 结束而消失的未完成 slot。消失的 done slot 早已结束。
	const toolEnds: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
	const endTool = (slot: ToolSlot, entryId: number | undefined): void => {
		const entry = entries.find((candidate) => candidate.id === entryId);
		toolEnds.push({ type: "tool_execution_end", ...callOf(slot), ...(entry === undefined ? {} : { entry }) });
	};
	for (const previous of slotsBefore.values()) {
		if (previous.status === "done") continue;
		const slot = slots.find((candidate) => candidate.callId === previous.callId);
		if (slot?.status === "done") endTool(slot, slot.entry);
		// 本次 commit 中 run 结束的 slot，其结果可能已随之追加，如同未启动的调用那样。
		else if (slot === undefined) endTool(previous, resultOf(entries, previous.callId)?.id);
	}
	for (const slot of slots) {
		if (slot.status === "done" && !slotsBefore.has(slot.callId)) endTool(slot, slot.entry);
	}
	// 本次 commit 中结束的嵌套调用，处理方式相同，子调用先于发起它们的调用：列表把父调用排在前，
	// 因此倒序遍历。
	const endNested = (slot: NestedToolSlot): void => {
		const result = nestedResults.get(String(slot.taskId));
		events.push({ type: "tool_execution_end", ...callOf(slot), ...(result === undefined ? {} : { result }) });
	};
	const nestedNow = new Map(nested.map((slot) => [slot.taskId, slot]));
	for (const previous of [...nestedBefore.values()].reverse()) {
		if (previous.status === "done") continue;
		const slot = nestedNow.get(previous.taskId);
		if (slot?.status === "done" || slot === undefined) endNested(slot ?? previous);
	}
	for (const slot of [...nested].reverse()) {
		if (slot.status === "done" && !nestedBefore.has(slot.taskId)) endNested(slot);
	}

	// entry 按追加顺序；工具的结束事件紧挨在其结果消息之前，与 coding agent 一致。
	let assistantAppended = false;
	for (const entry of entries) {
		events.push(...toolEnds.filter((end) => end.entry === entry));
		const message = entry.model?.[0];
		if (message === undefined) {
			events.push({ type: "entry_appended", entry });
			continue;
		}
		// 流式回答已随其第一个 partial 起始过了。
		const streamed = message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
		if (message.role === "assistant") assistantAppended = true;
		if (!streamed) events.push({ type: "message_start", message });
		events.push({ type: "message_end", entry });
	}
	// 没有结果 entry 的结束：被故障化或孤儿化的工具，或 run 已结束的工具。
	events.push(...toolEnds.filter((end) => end.entry === undefined));

	// 先是 compaction 结束、任务失败，然后是回合与 run 的结束。
	const compactionsBefore = was.live.compactions ?? [];
	const compactions = now.live.compactions ?? [];
	for (const { taskId, reason } of compactionsBefore) {
		if (!compactions.some((status) => status.taskId === taskId)) {
			events.push({ type: "compaction_end", taskId, reason });
		}
	}
	// generation 的回合在其 outcome 提交时结束：在 `completing` 持有或终态时，以先到者为准，
	// 因此在持有时刻创建的后继会在它之后启动。
	let turnEnded = false;
	for (const task of tasks.values()) {
		const status = task.state.status;
		if (task.kind === "pi.generation" && status === "completing" && !held.has(task.id)) {
			held.add(task.id);
			turnEnded = true;
		}
		if (status !== "terminal") continue;
		if (task.kind === "pi.generation" && !held.delete(task.id)) turnEnded = true;
		const outcome = task.state.outcome;
		if (outcome.status === "faulted" || outcome.status === "orphaned") {
			const message = outcome.status === "faulted" ? outcome.error.message : outcome.reason;
			events.push({ type: "task_failed", taskId: task.id, kind: task.kind, message });
		}
	}
	if (turnEnded) events.push({ type: "turn_end" });
	const run = now.live.run;
	const runBefore = was.live.run;
	const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
	if (runBefore !== undefined && runChanged) events.push({ type: "run_end", inputs: runBefore.inputs });

	// 先是提交与文档状态，然后是开始的事件。
	for (const record of submissions) events.push({ type: "submission", record });
	if (now.inbox !== was.inbox) events.push({ type: "inbox_update", items: queued(now.inbox) });
	// 已退役的文档读出其初始值，如同快照中的行为。
	if (now.agent !== was.agent) {
		events.push({ type: "agent_changed", agent: now.agent ?? AgentDoc.definition.initial() });
	}
	if (now.usage !== was.usage)
		events.push({ type: "usage_changed", usage: now.usage ?? UsageDoc.definition.initial() });
	for (const { taskId, reason, blocking } of compactions) {
		if (!compactionsBefore.some((status) => status.taskId === taskId)) {
			events.push({ type: "compaction_start", taskId, reason, blocking });
		}
	}
	if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });
	if (run !== undefined && run.taskId !== runBefore?.taskId && tasks.get(run.taskId)?.kind === "pi.generation") {
		events.push({ type: "turn_start" });
	}
	return events;
}

const PARTIAL_PATH = ["docs", "pi.live", "generation", "message"];

/** 把在途消息上的 view 操作翻译成消息变化（spec §9.4）。 */
function messageChanges(viewOps: readonly Op[], message: AssistantMessage): MessageChange[] {
	const changes: MessageChange[] = [];
	// 整块发送的 block 已把之后对它的所有变化都装进本批。
	const whole = new Set<number>();
	for (const op of viewOps) {
		// view 操作从不替换根。
		const path = op[1] as Path;
		if (!startsWith(path, PARTIAL_PATH)) {
			// 整条消息或整个 generation 被替换了。
			if (startsWith(PARTIAL_PATH, path)) return [{ type: "message", message }];
			continue;
		}
		const rest = path.slice(PARTIAL_PATH.length);
		if (rest[0] === "usage") continue;
		if (rest[0] !== "content") return [{ type: "message", message }];
		if (rest.length === 1) {
			if (op[0] !== "p" || op[3] !== 0) return [{ type: "message", message }];
			for (const [offset, block] of (op[4] as unknown as Block[]).entries()) {
				const type =
					block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start";
				changes.push({ type, contentIndex: op[2] + offset, block });
			}
			continue;
		}
		const contentIndex = rest[1] as number;
		const field = rest[2];
		if (whole.has(contentIndex)) continue;
		if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking")) {
			changes.push({ type: field === "text" ? "text_delta" : "thinking_delta", contentIndex, delta: op[2] });
		} else if (op[0] === "a" && field === "arguments") {
			changes.push({ type: "toolcall_delta", contentIndex, path: rest.slice(3), delta: op[2] });
		} else {
			whole.add(contentIndex);
			changes.push({ type: "block", contentIndex, block: message.content[contentIndex]! });
		}
	}
	return changes;
}

/** slot 工具事件的标识字段。 */
function callOf(slot: ToolSlot | NestedToolSlot): ToolEventCall {
	return {
		toolCallId: slot.callId,
		toolName: slot.name,
		...(slot.taskId === undefined ? {} : { taskId: slot.taskId }),
		...("parentCallId" in slot ? { parentToolCallId: slot.parentCallId, parentTaskId: slot.parentTaskId } : {}),
	};
}

/** `pi.live` 中 `at` 处运行中 slot 的输出、details 与诊断变化，来自其上的 view 操作。 */
function toolUpdate(
	viewOps: readonly Op[],
	at: readonly ["tools" | "nestedTools", number],
	slot: ToolSlot | NestedToolSlot,
	previous: ToolSlot | NestedToolSlot,
): Omit<Extract<AgentEvent, { type: "tool_execution_update" }>, "type" | keyof ToolEventCall> | undefined {
	const outputPath = ["docs", "pi.live", ...at, "output"];
	let trimStart = 0;
	let append = "";
	let set = false;
	for (const op of viewOps) {
		if (!startsWith(op[1] as Path, outputPath)) continue;
		if (op[0] === "t") trimStart += op[2];
		else if (op[0] === "a") append += op[2];
		else set = true;
	}
	let output: { trimStart?: number; append?: string } | { set: string } | undefined;
	if (set || (slot.output !== previous.output && trimStart === 0 && append === ""))
		output = { set: slot.output ?? "" };
	else if (trimStart > 0 || append !== "") {
		output = { ...(trimStart > 0 ? { trimStart } : {}), ...(append === "" ? {} : { append }) };
	}
	// safe replay 会清空运行中 slot 的进度：被移除的 details 发送 `null`，被移除的诊断发送 `[]`。
	const update = {
		...(output === undefined ? {} : { output }),
		...(slot.details === previous.details ? {} : { details: slot.details ?? null }),
		...(slot.diagnostics === previous.diagnostics ? {} : { diagnostics: slot.diagnostics ?? [] }),
	};
	return Object.keys(update).length === 0 ? undefined : update;
}

function startsWith(path: Path, prefix: readonly (string | number)[]): boolean {
	return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}
