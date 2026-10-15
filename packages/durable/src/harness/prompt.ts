import type { Context } from "@earendil-works/chord";
import type { Message, SystemMessage, Tool, ToolReference } from "@earendil-works/pi-ai";
import { declarationsEqual, getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { SystemEntry } from "../entries.ts";
import type { ContextEdit, TypedEntryDraft } from "../types.ts";
import type { ContextView, PromptInput, PromptSection, ToolRegistration } from "./types.ts";

/** 按顺序重放 system 消息后生效的各 section：就地设置，`null` 表示删除，重新添加即追加。 */
export function replaySections(messages: readonly Message[]): Map<string, string> {
	const shown = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "system" || message.sections === undefined) continue;
		for (const [key, value] of Object.entries(message.sections)) {
			if (value === null) shown.delete(key);
			else shown.set(key, value);
		}
	}
	return shown;
}

/**
 * 按顺序渲染 agent 的各个 section。返回 `undefined` 表示省略该 section；带标记的文本会包裹为 `<key>\n...\n</key>`。
 * 抛异常的 section 会保留其已展示的文本（如果有的话）并被上报；`context` 中止之后的错误会向外传播。
 */
export async function renderSections<Tool extends ToolRegistration>(
	sections: readonly PromptSection<Tool>[],
	input: PromptInput<Tool>,
	shown: ReadonlyMap<string, string>,
	report: (error: unknown) => void,
	context: Context,
): Promise<Map<string, string>> {
	const desired = new Map<string, string>();
	for (const section of sections) {
		let text: string | undefined;
		try {
			text = await section.render(input, context);
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			report(error);
			const kept = shown.get(section.key);
			if (kept !== undefined) desired.set(section.key, kept);
			continue;
		}
		if (text === undefined) continue;
		desired.set(section.key, section.tag === false ? text : `<${section.key}>\n${text}\n</${section.key}>`);
	}
	return desired;
}

type SystemDraft = TypedEntryDraft<never>;

type ToolChanges = { readonly toolsRemoved: ToolReference[]; readonly toolsAdded: Tool[] };

/**
 * 规划出若干 `pi.system` 条目，使 `view` 重放后的各 section 与工具在值和顺序上都等于 `desired` 与 `tools`。
 *
 * - context 中的 head 标记之后没有更晚的 `pi.system` 条目：写入一条完整基线，省略之前所有已被保留的
 *   `pi.system` 条目，即使它只是重述重放后的值，也照写不误。
 * - 否则，当最小的 section 补丁会留下不同顺序时：先移除全部已展示的 section，再按顺序重新添加
 *   每个 desired section。
 * - 否则只做修改值与 `null` 删除的最小补丁，或者什么都不写。
 *
 * 工具变更搭在最后一条规划条目上，或单独占用一条条目。
 */
export function planSystemEntries(
	view: ContextView,
	desired: ReadonlyMap<string, string>,
	tools: readonly Tool[],
	timestamp: number,
): SystemDraft[] {
	const head = view.head;
	if (head !== undefined && !view.entries.some((entry) => SystemEntry.is(entry) && entry.id > head.id)) {
		const edits: ContextEdit[] = view.entries
			.filter((entry) => SystemEntry.is(entry))
			.map((entry) => ({ target: entry.id, action: "omit" }));
		const baseline = systemEntry(
			Object.fromEntries(desired),
			{ toolsRemoved: [], toolsAdded: tools.map(toToolDeclaration) },
			timestamp,
		);
		return [edits.length === 0 ? baseline : { ...baseline, edits }];
	}
	const sections = planSections(replaySections(view.messages), desired);
	const changes = planTools(getCurrentTools(view.messages), tools);
	if (changes.toolsRemoved.length === 0 && changes.toolsAdded.length === 0) {
		return sections.map((patch) => systemEntry(patch, undefined, timestamp));
	}
	if (sections.length === 0) return [systemEntry(undefined, changes, timestamp)];
	return sections.map((patch, index) =>
		systemEntry(patch, index === sections.length - 1 ? changes : undefined, timestamp),
	);
}

/**
 * 从 `offered` 到 `desired` 的工具变更。声明有变化者会先移除再重新添加。重放会让保留的工具原位不动、
 * 新增者追加在尾部；当这样做无法得到期望顺序时，移除全部 offered 工具，再按顺序重新添加
 * 每个 desired 工具。
 */
function planTools(offered: readonly Tool[], desired: readonly Tool[]): ToolChanges {
	const wanted = new Map(desired.map((tool) => [tool.name, tool]));
	const kept = offered.filter((tool) => {
		const next = wanted.get(tool.name);
		return next !== undefined && declarationsEqual(tool, next);
	});
	const keptNames = new Set(kept.map((tool) => tool.name));
	const added = desired.filter((tool) => !keptNames.has(tool.name));
	const replayed = [...kept, ...added];
	if (replayed.some((tool, index) => tool.name !== desired[index]!.name)) {
		return {
			toolsRemoved: offered.map((tool) => ({ name: tool.name })),
			toolsAdded: desired.map(toToolDeclaration),
		};
	}
	return {
		toolsRemoved: offered.filter((tool) => !keptNames.has(tool.name)).map((tool) => ({ name: tool.name })),
		toolsAdded: added.map(toToolDeclaration),
	};
}

/** section 补丁：无、最小补丁，或当顺序会不同时的“先全删/再全加”一对补丁。 */
function planSections(
	shown: ReadonlyMap<string, string>,
	desired: ReadonlyMap<string, string>,
): Record<string, string | null>[] {
	const patchedOrder = [
		...[...shown.keys()].filter((key) => desired.has(key)),
		...[...desired.keys()].filter((key) => !shown.has(key)),
	];
	const desiredOrder = [...desired.keys()];
	if (patchedOrder.some((key, index) => key !== desiredOrder[index])) {
		return [Object.fromEntries([...shown.keys()].map((key) => [key, null])), Object.fromEntries(desired)];
	}

	const patch: Record<string, string | null> = {};
	for (const [key, value] of shown) {
		const next = desired.get(key);
		if (next !== value) patch[key] = next ?? null;
	}
	for (const [key, value] of desired) if (!shown.has(key)) patch[key] = value;
	return Object.keys(patch).length === 0 ? [] : [patch];
}

function systemEntry(
	sections: Record<string, string | null> | undefined,
	tools: ToolChanges | undefined,
	timestamp: number,
): SystemDraft {
	const message: SystemMessage = {
		role: "system",
		content: "",
		...(sections === undefined ? {} : { sections }),
		...(tools === undefined || tools.toolsRemoved.length === 0 ? {} : { toolsRemoved: tools.toolsRemoved }),
		...(tools === undefined || tools.toolsAdded.length === 0 ? {} : { toolsAdded: tools.toolsAdded }),
		timestamp,
	};
	return { model: [message] };
}
