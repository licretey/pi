import type { JsonValue } from "@earendil-works/chord";
import type { CompactionReason, ToolDiagnostic } from "./harness/types.ts";
import type { Entry, EntryRecord, TypedEntry } from "./types.ts";

/** 定义一个带类型的条目种类，其 `is()` 守卫按 `EntryRecord.kind` 收窄类型。 */
export function defineEntry<D extends JsonValue = never>(kind: string): Entry<D> {
	if (typeof kind !== "string" || kind.length === 0) throw new TypeError("Entry kind must be a non-empty string");
	return {
		kind,
		is: (entry: EntryRecord | undefined): entry is TypedEntry<D> => entry !== undefined && entry.kind === kind,
	};
}

/** 用户输入：`model` 为 `[UserMessage]`。由提交请求写入。 */
export const UserEntry = defineEntry("pi.user");
/** 携带任意停止原因的提供方结果：`model` 为 `[AssistantMessage]`。由 generation 写入。 */
export const AssistantEntry = defineEntry("pi.assistant");
/** 位置性提示与工具变更：`model` 为具有空 `content` 的 `[SystemMessage]`。 */
export const SystemEntry = defineEntry("pi.system");
/**
 * 工具结果：`model` 为 `[ToolResultMessage]`，其内容以渲染出的诊断块结尾；`data` 保存结构化的诊断信息，可能为空。
 * 由工具任务写入，generation 也会为其未主动提供的调用写入。
 */
export const ToolResultEntry = defineEntry<{ diagnostics: ToolDiagnostic[] }>("pi.tool-result");
/**
 * 新上下文的起点：恒为 `head: "self"`；纯重置时没有 `model`，否则 `[UserMessage]` 携带交接文本。
 * 由 `Conversation.reset()` 和 `handoff` 工具控制写入。
 */
export const ResetEntry = defineEntry("pi.reset");
/**
 * 压缩摘要：`model` 为包裹了摘要的 `[UserMessage]`，`head` 指向第一条被保留的条目。
 * 由压缩任务直接写入，或通过写提交请求写入。
 */
export const CompactionEntry = defineEntry<{ reason: CompactionReason }>("pi.compaction");
