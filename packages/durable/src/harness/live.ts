import type { Draft, JsonRepresentation, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";
import type { Transaction } from "../session/transaction.ts";
import type { EntryId, JsonObject, SubmissionId, SubmissionSettlement, TaskId, TaskRecord, Tx } from "../types.ts";
import { convertPartial } from "./generation.ts";
import type { SchedulerOutcome } from "./scheduler.ts";
import type { CompactionReason, CompactionResult, ToolDiagnostic } from "./types.ts";

/** 运行中的工具调用所发布的状态，供模型发起的调用和嵌套调用共用。 */
type SlotProgress = {
	callId: string;
	name: string;
	status: "pending" | "running" | "done";
	/** 保留的运行中输出，以及因长度限制而丢弃的内容。 */
	output?: string;
	droppedBytes?: number;
	droppedLines?: number;
	/** 最近一次 `details()` 的值。 */
	details?: JsonValue;
	/** 通过 `api.diagnostic()` 记录的诊断信息。 */
	diagnostics?: ToolDiagnostic[];
};

/** 当前这一轮中单个工具调用的展示状态。 */
export type ToolSlot = SlotProgress & {
	/**
	 * 尚未开始的调用（串行轮次）不会设置此字段；请求未提供调用信息的工具会直接以 `done` 状态开始，
	 * 并使用生成阶段写入的 `entry`。
	 */
	taskId?: TaskId;
	/** 调用结束后的结果条目；工具任务出错或成为孤立任务时不设置。 */
	entry?: EntryId;
};

/**
 * 单个嵌套调用的展示状态：由运行中的工具通过 `executeTool()` 发起。`callId` 的格式为
 * `<parentCallId>/<key>`，是工具事件中的调用 ID；由于 key 不含 `/`，因此 ID 唯一。Harness 通过任务 ID 关联槽位：
 * `taskId` 是该调用的工具任务，`parentTaskId` 是调用它的任务（可能由模型发起，也可能是嵌套调用）。
 */
export type NestedToolSlot = SlotProgress & {
	parentCallId: string;
	parentTaskId: TaskId;
	taskId: TaskId;
	/**
	 * 调用发起时使用的参数；开始执行后，此字段会被经过修复、`beforeTool` 处理和类型转换的实际参数替换。
	 * 模型发起的调用参数则保存在 assistant 条目中。
	 */
	arguments: JsonObject;
	/** 调用结束后的状态摘要，用于状态栏；调用结果本身保存在调用方的 `NestedResultDoc` 中。 */
	summary?: NestedToolSummary;
};

/** 嵌套调用的结束信息：是否出错、执行时长、用量，以及最多 500 个字符的错误文本。 */
export type NestedToolSummary = {
	isError: boolean;
	durationMs?: number;
	usage?: JsonRepresentation<Usage>;
	error?: string;
};

/** 单个运行中压缩任务的展示状态（规范 §8.7）。 */
export type CompactionStatus = {
	taskId: TaskId<CompactionResult>;
	reason: CompactionReason;
	/** 生成任务是否正在等待该压缩任务，即该生成任务拥有的压缩任务。 */
	blocking: boolean;
	attempt: number;
	/** 下次尝试生成摘要前持久化的退避时间。 */
	retry?: { at: number; error: string };
};

/** 内置的实时对话状态：运行控制，以及当前生成和工具轮次的展示信息。 */
export type LiveState = {
	/** 运行控制：负责结算本次运行输入的任务及其输入；仅在运行繁忙时存在。 */
	run?: { taskId: TaskId; inputs: SubmissionId[] };
	/** 当前生成尝试的展示信息。 */
	generation?: {
		attempt: number;
		/** 已提交并经过节流的响应生成中间内容。 */
		message?: JsonRepresentation<AssistantMessage>;
		/** 下次尝试前持久化的退避时间。 */
		retry?: { at: number; error: string };
		/** 正在轮询的提供商延迟响应。 */
		deferred?: { pollAt: number };
	};
	/** 当前工具轮次，按调用顺序排列；从模型给出工具调用的回答开始，到生成任务结束 `tools` 阶段为止。 */
	tools?: ToolSlot[];
	/**
	 * 运行中工具调用发起的嵌套调用，按创建顺序排列，因此父调用在子调用之前，任务 ID 递增。调用
	 * 结算后会移除该调用对应的嵌套槽位。
	 */
	nestedTools?: NestedToolSlot[];
	/** 按任务 ID 排序的运行中压缩任务；没有任务时不设置。 */
	compactions?: CompactionStatus[];
};

export const LiveDoc = defineDoc<LiveState>({
	kind: "pi.live",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	// 提醒：没有任务运行时应始终形成完整基线（规范 §8.2），即不存在生成任务和运行中的工具槽位。此规则适用于
	// 空闲时、生成任务交接给工具轮次的提交中，以及工具之间。因此增量链
	// 最多只跨越一次生成过程，或同一轮工具的并行执行。槽位只在工具运行时保存输出，
	// 因此每个基线都很小；嵌套调用结果保存在调用方的任务文档中，不会放在这里。不要
	// 添加增量数量上限；工具输出基准测试会验证此规则。
	checkpointWhen: (value) =>
		value.generation === undefined &&
		!(value.tools ?? []).some((slot) => slot.status === "running") &&
		!(value.nestedTools ?? []).some((slot) => slot.status === "running"),
});

/** 可以拥有 `pi.live.run` 的内置任务类型。 */
const RUN_TASK_KINDS: ReadonlySet<string> = new Set(["pi.generation"]);
const TOOL_TASK_KIND = "pi.tool";
const COMPACTION_TASK_KIND = "pi.compaction";

/**
 * 结束由 `taskId` 拥有的运行：结算其所有输入并移除 `run`。同时始终移除属于该次运行的
 * `generation`、`tools` 和 `nestedTools` 展示状态。
 */
export function endRun(tx: Tx, live: Draft<LiveState>, taskId: TaskId, settlement: SubmissionSettlement): void {
	if (live.run?.taskId === taskId) {
		for (const id of live.run.inputs) tx.settleSubmission(id, settlement);
		delete live.run;
	}
	delete live.generation;
	delete live.tools;
	delete live.nestedTools;
}

/** 添加本次提交中创建的压缩任务状态；状态列表始终按任务 ID 排序。 */
export function addCompactionStatus(live: Draft<LiveState>, status: CompactionStatus): void {
	live.compactions ??= [];
	live.compactions.push(status);
}

/** 返回列表中压缩任务 `taskId` 的状态（如果存在）。 */
export function compactionStatus(live: Draft<LiveState>, taskId: TaskId): Draft<CompactionStatus> | undefined {
	return live.compactions?.find((status) => status.taskId === taskId);
}

/** 移除压缩任务 `taskId` 的状态；列表为空时一并移除列表。 */
export function removeCompactionStatus(live: Draft<LiveState>, taskId: TaskId): void {
	const statuses = live.compactions;
	if (statuses === undefined) return;
	const index = statuses.findIndex((status) => status.taskId === taskId);
	if (index >= 0) statuses.splice(index, 1);
	if (statuses.length === 0) delete live.compactions;
}

/**
 * 如果 `pi.live` 仍记录工具任务 `taskId`，则返回其槽位（可能由模型发起，也可能是嵌套调用）。嵌套槽位通过二分查找定位：
 * 查找定位：工具可能发起数千次嵌套调用，每次调用都会在多个提交中查找槽位，而每个
 * 被查找的元素都会在草稿变更跟踪器中占用一个节点。任务 ID 按递增顺序排列：每个槽位都在创建任务的提交中追加，
 * 任务 ID 随提交顺序递增，移除操作也会保持原有顺序。
 */
export function toolSlot(live: Draft<LiveState>, taskId: TaskId): Draft<ToolSlot | NestedToolSlot> | undefined {
	const slot = live.tools?.find((each) => each.taskId === taskId);
	if (slot !== undefined || live.nestedTools === undefined) return slot;
	const nested = live.nestedTools;
	let low = 0;
	let high = nested.length - 1;
	while (low <= high) {
		const middle = (low + high) >>> 1;
		const candidate = nested[middle]!;
		if (candidate.taskId === taskId) return candidate;
		if (candidate.taskId < taskId) low = middle + 1;
		else high = middle - 1;
	}
	return undefined;
}

/**
 * 将槽位标记为完成并清除运行中输出；调用方会设置模型发起调用的结果 `entry`，或设置嵌套调用的
 * `summary`。任务出错或成为孤立任务时，两者都不会设置。
 */
export function finishSlot(slot: Draft<ToolSlot | NestedToolSlot>): void {
	slot.status = "done";
	clearProgress(slot);
}

/** 递归移除工具任务 `taskId` 下的嵌套槽位；列表中父调用排在子调用之前。 */
export function removeNestedSlots(live: Draft<LiveState>, taskId: TaskId): void {
	const nested = live.nestedTools;
	if (nested === undefined) return;
	const removed = new Set<TaskId>([taskId]);
	for (const slot of nested) if (removed.has(slot.parentTaskId)) removed.add(slot.taskId);
	for (let index = nested.length - 1; index >= 0; index--) {
		if (removed.has(nested[index]!.parentTaskId)) nested.splice(index, 1);
	}
	if (nested.length === 0) delete live.nestedTools;
}

/** 移除工具运行期间发布的内容；这些内容会由结果条目或重新运行的内容取代。 */
export function clearProgress(slot: Draft<SlotProgress>): void {
	delete slot.output;
	delete slot.droppedBytes;
	delete slot.droppedLines;
	delete slot.details;
	delete slot.diagnostics;
}

/**
 * Harness 用于清理调度器自行写入的终态（`faulted` 或 `orphaned`）。运行任务会结束其运行；
 * 工具任务的槽位会被标记为完成但不设置条目，随后由上下文推导逻辑合成缺失的结果；
 * 压缩任务的状态则会被移除。
 * 忽略其他任务类型，以免在其他位置创建 `pi.live`。调度器调用此函数时并不知道任务类型，
 * 因此由 Harness 传入此函数（规范 §5.4）。
 * 提醒：已提交的生成中间内容会在此处转换为已中止的 assistant 条目，与生成中止
 * 处理器中的行为完全一致。因此记录会保留模型已生成的内容，`pi.usage` 也会计入相应用量。调度器的提交
 * 不属于任何任务作用域，因此该条目没有 `byTaskId`。出错可能源于任务缺陷
 * 或格式错误的提供商数据（例如响应中包含非 JSON 值），也可能是 Storage 未产生任何影响便拒绝了提交；
 * 若 Storage 故障状态不确定，则会使 Session 失效，并且不写入终态。
 */
export async function settleSchedulerOutcome(
	tx: Transaction,
	record: TaskRecord<JsonValue, JsonValue, JsonValue>,
	outcome: SchedulerOutcome,
): Promise<void> {
	if (record.kind === TOOL_TASK_KIND) {
		const live = await tx.doc(LiveDoc, record.conversationId);
		const slot = toolSlot(live, record.id);
		if (slot !== undefined) finishSlot(slot);
		removeNestedSlots(live, record.id);
		return;
	}
	if (record.kind === COMPACTION_TASK_KIND) {
		removeCompactionStatus(await tx.doc(LiveDoc, record.conversationId), record.id);
		return;
	}
	if (!RUN_TASK_KINDS.has(record.kind)) return;
	const live = await tx.doc(LiveDoc, record.conversationId);
	if (live.run?.taskId !== record.id) return;
	await convertPartial(tx, live, record.conversationId);
	endRun(
		tx,
		live,
		record.id,
		outcome.status === "faulted"
			? { status: "unanswered", reason: "faulted", detail: outcome.error.message }
			: { status: "unanswered", reason: outcome.reason },
	);
}
