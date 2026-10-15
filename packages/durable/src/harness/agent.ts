import { copyJson, type Draft } from "@earendil-works/chord";
import { defineDoc } from "../documents.ts";
import type { ConversationId, ConversationRecord, Tx } from "../types.ts";
import type {
	Agent,
	AgentChange,
	AgentState,
	CompactionPolicy,
	ConversationRetryPolicy,
	Extension,
	HarnessSettings,
	ProgressPolicy,
	PromptSection,
	RegistrySnapshot,
	Settings,
	ToolRegistration,
} from "./types.ts";

export const DEFAULT_RETRY_POLICY: ConversationRetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxAgentDelayMs: 60000,
};

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
};

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
	partialIntervalMs: 100,
	outputIntervalMs: 100,
};

/** agent `instructions` 占用的保留 section 键。 */
export const INSTRUCTIONS_KEY = "instructions";

/** 内建的 agent 文档；可回退，因此分叉能从其分叉点处的 agent 状态开始。 */
export const AgentDoc = defineDoc<AgentState>({
	kind: "pi.agent",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** 默认的 `settings.contextRetentionMs`：十分钟。 */
const DEFAULT_CONTEXT_RETENTION_MS = 600_000;

/** 解析宿主设置：每个字段覆盖其内建默认值，对象字段做合并。 */
export function resolveSettings(settings: HarnessSettings | undefined): Settings {
	const extensions = settings?.extensions;
	return {
		...(extensions === undefined ? {} : { extensions }),
		stream: { ...settings?.stream },
		retry: { ...DEFAULT_RETRY_POLICY, ...settings?.retry },
		compaction: { ...DEFAULT_COMPACTION_POLICY, ...settings?.compaction },
		// 逐字段处理，让显式的 undefined 间隔仍旧保有默认值。
		progress: {
			partialIntervalMs: settings?.progress?.partialIntervalMs ?? DEFAULT_PROGRESS_POLICY.partialIntervalMs,
			outputIntervalMs: settings?.progress?.outputIntervalMs ?? DEFAULT_PROGRESS_POLICY.outputIntervalMs,
		},
		toolExecution: settings?.toolExecution ?? "parallel",
		steeringMode: settings?.steeringMode ?? "one-at-a-time",
		followUpMode: settings?.followUpMode ?? "one-at-a-time",
		contextRetentionMs: settings?.contextRetentionMs ?? DEFAULT_CONTEXT_RETENTION_MS,
	};
}

/** 对 `pi.agent` 应用一次变更：给定的字段替换存储值，`null` 清除它，`undefined` 不造成任何改变。 */
export async function configure(tx: Tx, conversationId: ConversationId, change: AgentChange): Promise<void> {
	const state = await tx.doc(AgentDoc, conversationId);
	applyChange(state, change);
}

/**
 * 工具轮次中的 `addTools`，同时应用于 `tools` 与 `modelTools`，让下一个请求提供这些工具：数组形式把缺少的
 * 名称逐个追加，`{ remove }` 形式删去这些名称，而未设置的过滤器本就放行所有工具，因此什么也不写。
 */
export async function addTools(tx: Tx, conversationId: ConversationId, added: readonly string[]): Promise<void> {
	const state = await tx.doc(AgentDoc, conversationId);
	for (const field of ["tools", "modelTools"] as const) {
		const filter = state[field];
		if (filter === undefined) continue;
		if (Array.isArray(filter)) {
			for (const name of added) if (!filter.includes(name)) filter.push(name);
		} else {
			const remove = (filter as { remove: string[] }).remove;
			if (remove.some((name) => added.includes(name))) {
				state[field] = { remove: remove.filter((name) => !added.includes(name)) };
			}
		}
	}
}

function applyChange(state: Draft<AgentState>, change: AgentChange): void {
	const set = <K extends keyof AgentState>(key: K, value: AgentState[K] | null | undefined) => {
		if (value === undefined) return;
		if (value === null) delete state[key];
		else state[key] = value as Draft<AgentState>[K];
	};
	set("model", change.model === undefined || change.model === null ? change.model : { ...change.model });
	set("thinkingLevel", change.thinkingLevel);
	const extensions = change.extensions;
	set(
		"extensions",
		extensions === undefined || extensions === null
			? extensions
			: isList(extensions)
				? names(extensions)
				: {
						...(extensions.add === undefined ? {} : { add: names(extensions.add) }),
						...(extensions.remove === undefined ? {} : { remove: names(extensions.remove) }),
					},
	);
	for (const field of ["tools", "modelTools"] as const) {
		const filter = change[field];
		set(
			field,
			filter === undefined || filter === null
				? filter
				: isList(filter)
					? names(filter)
					: { remove: names(filter.remove) },
		);
	}
	set("instructions", change.instructions);
	set("cwd", change.cwd);
}

function isList<T>(value: readonly T[] | object): value is readonly T[] {
	return Array.isArray(value);
}

function names(items: readonly { readonly name: string }[]): string[] {
	return items.map((item) => item.name);
}

/**
 * 每个创建或分叉对话的 Harness 提交中为 `pi.agent` 执行的内建部分：分叉保留其 `asOf` 副本；任务所有的
 * 新对话复制其属主任务的对话所存储的 agent；新的无主对话则空起炉灶。
 */
export async function createAgent(tx: Tx, conversation: ConversationRecord): Promise<void> {
	if (conversation.parent !== undefined) return;
	const agent = await tx.doc(AgentDoc, conversation.id);
	if (conversation.owner === undefined) return;
	const owner = await tx.doc(AgentDoc, conversation.owner.conversationId);
	Object.assign(agent, copyJson(owner) as AgentState);
}

/** 按扩展顺序，取所选扩展中属于某任务名的钩子处理器。 */
export function agentHooks(agent: Agent, taskName: string): object[] {
	const handlers: object[] = [];
	for (const extension of agent.extensions) {
		for (const hook of extension.hooks ?? []) if (hook.task === taskName) handlers.push(hook.handlers);
	}
	return handlers;
}

/**
 * 从已存状态（缺失时表示所有字段未设置）、注册表快照与已解析设置中解析出一个 agent。抛错或改名的包装器
 * 会丢弃其目标并被上报；没有目标的包装器不做任何事。
 */
export function resolveAgent<Tool extends ToolRegistration>(
	state: Readonly<AgentState> | undefined,
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
	report: (error: unknown) => void,
): Agent<Tool> {
	const extensions = selectExtensions(state?.extensions, snapshot, settings);

	const composed = new Map<string, Tool>();
	for (const extension of extensions) for (const tool of extension.tools ?? []) composed.set(tool.name, tool);
	const sections = new Map<string, PromptSection<Tool>>();
	for (const extension of extensions) {
		for (const section of extension.sections ?? []) sections.set(section.key, section);
	}
	for (const extension of extensions) {
		for (const wrap of extension.wraps ?? []) {
			if ("tool" in wrap)
				applyWrap(
					composed,
					wrap.tool,
					(tool) => wrap.wrap(tool),
					(tool) => tool.name,
					report,
				);
			else
				applyWrap(
					sections,
					wrap.section,
					(section) => wrap.wrap(section),
					(section) => section.key,
					report,
				);
		}
	}

	const enabled = filterTools([...composed.values()], state?.tools);
	const callableBy = (caller: "model" | "tools") => (tool: Tool) =>
		tool.callers === undefined || tool.callers.includes(caller);
	const tools = filterTools(enabled.filter(callableBy("model")), state?.modelTools);
	const callable = enabled.filter(callableBy("tools"));

	const instructions = state?.instructions;
	const agentSections = [...sections.values()];
	if (instructions !== undefined) agentSections.push({ key: INSTRUCTIONS_KEY, render: () => instructions });

	const agent: Agent<Tool> = {
		...(state?.model === undefined ? {} : { model: state.model }),
		thinkingLevel: state?.thinkingLevel ?? "off",
		extensions,
		tools,
		callable,
		sections: agentSections,
		...(instructions === undefined ? {} : { instructions }),
		...(state?.cwd === undefined ? {} : { cwd: state.cwd }),
	};
	return agent;
}

/** 用已存的过滤器过滤 `tools`：数组精确选出其名称、按其顺序；`{ remove }` 删去相应名称。 */
function filterTools<Tool extends ToolRegistration>(tools: Tool[], filter: AgentState["tools"]): Tool[] {
	if (filter === undefined) return tools;
	if (Array.isArray(filter)) {
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		return [...new Set(filter)].flatMap((name) => {
			const tool = byName.get(name);
			return tool === undefined ? [] : [tool];
		});
	}
	const removed = new Set((filter as { remove: string[] }).remove);
	return tools.filter((tool) => !removed.has(tool.name));
}

/** 选中的已安装扩展：用已存数组，或用 `{ add, remove }` 编辑后的默认选择。 */
function selectExtensions<Tool extends ToolRegistration>(
	stored: AgentState["extensions"],
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
): Extension<Tool>[] {
	let selected: string[];
	if (Array.isArray(stored)) selected = stored;
	else {
		const base = settings.extensions?.map((extension) => extension.name) ?? snapshot.installed().map((e) => e.name);
		const edit = stored as { add?: string[]; remove?: string[] } | undefined;
		const removed = new Set(edit?.remove ?? []);
		selected = [...base, ...(edit?.add ?? [])].filter((name) => !removed.has(name));
	}
	const extensions: Extension<Tool>[] = [];
	for (const name of new Set(selected)) {
		const extension = snapshot.extension(name);
		if (extension !== undefined) extensions.push(extension);
	}
	return extensions;
}

function applyWrap<T>(
	items: Map<string, T>,
	target: string,
	wrap: (item: T) => T,
	nameOf: (item: T) => string,
	report: (error: unknown) => void,
): void {
	const item = items.get(target);
	if (item === undefined) return;
	try {
		const wrapped = wrap(item);
		if (nameOf(wrapped) !== target) throw new Error(`Wrapper renamed ${target} to ${nameOf(wrapped)}`);
		items.set(target, wrapped);
	} catch (error) {
		items.delete(target);
		report(error);
	}
}
