import type { Context, Message, SystemMessage, Tool, ToolReference, TranscriptContext } from "../types.ts";
import { contentText, getSystemMessageText } from "./text.ts";

export type { TranscriptContext } from "../types.ts";

/**
 * 为提示词与工具集构建开头的系统消息。两者都为空时返回 undefined，
 * 因此空的 transcript 保持为空。
 */
export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: Tool[] | undefined,
): SystemMessage | undefined {
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return undefined;
	return {
		role: "system",
		content: systemPrompt ?? "",
		...(hasTools ? { toolsAdded: tools } : {}),
		timestamp: 0,
	};
}

/**
 * 将 `Context.systemPrompt` 与 `Context.tools` 折叠进开头的系统消息。
 * 这是唯一能产出 {@link TranscriptContext} 的入口；
 * 每个面向提供商的函数都期望接收其结果。
 */
export function normalizeContext(context: Context): TranscriptContext {
	const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
	const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
	return { messages } as TranscriptContext;
}

/**
 * 任意消息列表。重放辅助函数只读取 role 为 `"system"` 的条目，
 * 因此携带自定义消息角色的 agent transcript 可以不经过滤直接传入。
 */
export type TranscriptMessages = readonly { role: string }[];

function isSystemMessage(message: { role: string }): message is SystemMessage {
	return message.role === "system";
}

/** 返回开头的系统消息；若 transcript 不以系统消息开头则为 undefined。 */
export function getInitialSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const first = messages[0];
	return first && isSystemMessage(first) ? first : undefined;
}

/** 为把提示词放在消息列表之外的 API 去掉开头的系统消息。 */
export function withoutInitialSystemMessage(messages: Message[]): Message[] {
	return getInitialSystemMessage(messages) ? messages.slice(1) : messages;
}

/** 按顺序应用 transcript 中的每个变化后，解析出当前可用的工具。 */
export function getCurrentTools(messages: TranscriptMessages): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/**
 * 将所有系统消息重放进一个持有当前提示词与工具的开头系统消息。
 * 较晚的 `content` 追加到基础提示词之后，`sections` 按名称做补丁式更新，
 * 工具用 {@link getCurrentTools} 解析。
 */
export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** 重放所有系统消息后，渲染当前的系统提示词文本。 */
export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : "";
}

/**
 * 为不支持对话中途系统消息的 API 重建 transcript：重放后的系统消息
 * 放在开头，之后的所有系统消息都被丢弃。
 */
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
	const head = getCurrentSystemMessage(context.messages);
	const messages = context.messages.filter((message) => message.role !== "system");
	return { messages: head ? [head, ...messages] : messages } as TranscriptContext;
}

/** 模型接受对话中途系统消息时保留原样；否则折叠为一条。 */
export function resolveTranscript(
	context: TranscriptContext,
	supportsMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
	return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}

/** 在做 transcript 比较或持久化之前，剥离工具上可执行与仅供展示的字段。 */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

/**
 * 判断两个工具是否向模型声明了相同的接口。
 *
 * 两侧都先经过 {@link toToolDeclaration}：其 JSON 往返会丢弃结构比较本会看到的
 * typebox 符号键和 `undefined` 字段，并以相同的键序构建两个对象，因此比较
 * 序列化后的声明是精确的。这避免了在浏览器安全的包里引入 deep-equal 依赖。
 */
export function declarationsEqual(left: Tool, right: Tool): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: ToolReference[];
}

/** 比较两个完整的工具状态。被修改的定义表现为一次移除后跟一次新增。 */
export function getToolStateChanges(previous: readonly Tool[], current: readonly Tool[]): ToolStateChanges {
	const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
	const currentTools = new Map(current.map((tool) => [tool.name, tool]));
	return {
		toolsAdded: current
			.filter((tool) => {
				const previousTool = previousTools.get(tool.name);
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			.map(toToolDeclaration),
		toolsRemoved: previous
			.filter((tool) => {
				const currentTool = currentTools.get(tool.name);
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			.map((tool) => ({ name: tool.name })),
	};
}

/** transcript 工具状态引用的所有定义，按首次声明顺序排列。 */
export function getDeclaredTools(messages: TranscriptMessages): Tool[] {
	const definitions = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) definitions.set(tool.name, tool);
	}
	return [...definitions.values()];
}

/**
 * 某个工具名是否以不同定义被声明了两次。只能按名称引用先前已声明工具的
 * 传输层无法重放这样的历史。
 *
 * @deprecated 已无内置传输层需要此函数：Anthropic 用内联的 `tool_definition`
 * 块表达重定义。保留仅为 API 兼容性，未来版本将移除。
 */
export function hasToolRedefinitions(messages: TranscriptMessages): boolean {
	const declared = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) {
			const previous = declared.get(tool.name);
			if (previous !== undefined && !declarationsEqual(previous, tool)) return true;
			declared.set(tool.name, tool);
		}
	}
	return false;
}

/** 工具历史中是否包含「只支持新增」的传输层无法重放的变化：移除或同名重声明。 */
export function hasNonAdditiveToolChanges(messages: TranscriptMessages): boolean {
	const declared = new Set<string>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		if ((message.toolsRemoved?.length ?? 0) > 0) return true;
		for (const tool of message.toolsAdded ?? []) {
			if (declared.has(tool.name)) return true;
			declared.add(tool.name);
		}
	}
	return false;
}

export interface TranscriptTools {
	/** 发送在顶层请求字段中的工具。 */
	requestTools: Tool[];
	/**
	 * 较晚的系统消息是否以原地新增的方式携带各自的 `toolsAdded`。
	 * 为 false 时，`requestTools` 已持有完整的当前工具集。
	 */
	anchorsAdditions: boolean;
}

/**
 * 在顶层请求字段与原地新增之间拆分工具声明。
 * 能把新增锚定到系统消息上的传输层将初始工具放在顶部、并在后续工具
 * 出现的位置加载它们；这只有在没有工具被移除或重声明时才可行，
 * 因此其余情况一律发送当前的工具列表。
 */
export function resolveTranscriptTools(messages: TranscriptMessages, supportsToolAdditions: boolean): TranscriptTools {
	const anchorsAdditions = supportsToolAdditions && !hasNonAdditiveToolChanges(messages);
	return {
		requestTools: anchorsAdditions
			? (getInitialSystemMessage(messages)?.toolsAdded ?? [])
			: getCurrentTools(messages),
		anchorsAdditions,
	};
}
