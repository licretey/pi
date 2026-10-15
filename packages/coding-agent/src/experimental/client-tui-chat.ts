import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryRecord, InboxState, LiveState } from "@earendil-works/pi-durable";
import { Container, Spacer, Text, TruncatedText, type TUI } from "@earendil-works/pi-tui";
import { createAllToolRenderers } from "../core/tools/renderers/index.ts";
import { AssistantMessageComponent } from "../modes/interactive/components/assistant-message.ts";
import { type StatusIndicator, WorkingStatusIndicator } from "../modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent, type ToolRenderers } from "../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../modes/interactive/components/user-message.ts";
import { theme } from "../modes/interactive/theme/theme.ts";

/** 视图的 `pi.live` 文档：当前运行、流式回答和正在执行的工具。 */
export function liveOf(view: ConversationView): LiveState {
	return (view.docs["pi.live"] ?? {}) as LiveState;
}

function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** 为纯服务实验性呈现界面渲染根会话的持久化视图。 */
export class ExperimentalChatView {
	static readonly #renderers: Record<string, ToolRenderers> = createAllToolRenderers();

	readonly transcript = new Container();
	readonly pendingMessages = new Container();
	readonly status = new Container();
	readonly #ui: TUI;
	readonly #cwd: string;
	/** 每个调用 ID 对应的最新卡片；提供商可能在不同轮次中重复使用调用 ID。 */
	readonly #tools = new Map<string, ToolExecutionComponent>();
	/** 所有已显示的卡片，也包括调用 ID 后来被复用的旧卡片。 */
	readonly #cards: ToolExecutionComponent[] = [];
	/** 流式回答创建卡片时对应的调用 ID；回答条目会接管这些卡片。 */
	readonly #streamingCalls = new Set<string>();
	#renderedEntryIds: number[] = [];
	#streaming: AssistantMessageComponent | undefined;
	#indicator: StatusIndicator | undefined;
	#statusText = "";

	constructor(ui: TUI, cwd: string) {
		this.#ui = ui;
		this.#cwd = cwd;
	}

	apply(view: ConversationView): void {
		const live = liveOf(view);
		this.#syncTranscript(view.entries);
		const message = live.generation?.message as AssistantMessage | undefined;
		// 部分流式内容若未形成条目（例如重试时被丢弃），则重新渲染对话记录。
		if (message === undefined && this.#streaming !== undefined) this.#rebuild(view.entries);
		if (message !== undefined) this.#syncStreaming(message);
		for (const slot of live.tools ?? []) {
			if (slot.status === "pending") continue;
			const component = this.#tool(slot.name, slot.callId);
			component.setArgsComplete();
			if (slot.status !== "running") continue;
			component.markExecutionStarted();
			if (slot.output !== undefined) {
				component.updateResult(
					{ content: [{ type: "text", text: slot.output }], details: slot.details, isError: false },
					true,
				);
			}
		}
		this.#syncQueue((view.docs["pi.inbox"] ?? { items: [] }) as InboxState);
		this.#syncStatus(live);
		this.transcript.invalidate();
		this.pendingMessages.invalidate();
		this.status.invalidate();
	}

	refreshTheme(view: ConversationView): void {
		this.#indicator?.dispose();
		this.#indicator = undefined;
		this.#statusText = "";
		this.status.clear();
		this.#rebuild(view.entries);
		this.apply(view);
	}

	dispose(): void {
		this.#discardTools();
		this.#indicator?.dispose();
	}

	/** 结束所有卡片：运行中的 Bash 卡片会持续计时，直到收到最终结果。 */
	#discardTools(): void {
		for (const component of this.#cards) component.updateResult({ content: [], isError: false }, false);
		this.#cards.length = 0;
		this.#tools.clear();
		this.#streamingCalls.clear();
	}

	#syncQueue(inbox: InboxState): void {
		this.pendingMessages.clear();
		for (const item of inbox.items) {
			const text =
				item.mode === "write"
					? `<${String(item.entry.kind)}>`
					: userText(item.content as UserMessage["content"]).replace(/\s+/g, " ");
			this.pendingMessages.addChild(new TruncatedText(theme.fg("muted", `[${item.mode}] ${text}`), 1, 0));
		}
	}

	#syncStatus(live: LiveState): void {
		const generation = live.generation;
		const compaction = live.compactions?.[0];
		const runningTool = live.tools?.find((slot) => slot.status === "running");
		let text = "";
		if (generation?.retry !== undefined) {
			text = `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
		} else if (generation?.deferred !== undefined) text = "Waiting for deferred response...";
		else if (compaction !== undefined) {
			text = compaction.retry
				? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...`
				: `Compacting (${compaction.reason})...`;
		} else if (runningTool !== undefined) text = `Running ${runningTool.name}... (esc to abort)`;
		else if (live.run !== undefined) text = "Working... (esc to abort)";
		if (text === this.#statusText) return;
		this.#statusText = text;
		this.#indicator?.dispose();
		this.#indicator = undefined;
		this.status.clear();
		if (text.length > 0) {
			this.#indicator = new WorkingStatusIndicator(this.#ui, text);
			this.status.addChild(this.#indicator);
		}
	}

	#syncTranscript(entries: readonly EntryRecord[]): void {
		// 压缩和重置操作会替换当前对话记录的上下文起点。
		if (this.#renderedEntryIds.some((id, index) => entries[index]?.id !== id)) this.#rebuild(entries);
		for (const entry of entries.slice(this.#renderedEntryIds.length)) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#rebuild(entries: readonly EntryRecord[]): void {
		this.transcript.clear();
		this.#discardTools();
		this.#renderedEntryIds = [];
		this.#streaming = undefined;
		for (const entry of entries) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#addEntry(entry: EntryRecord): void {
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message?.role === "user") {
			this.transcript.addChild(new Spacer(1));
			this.transcript.addChild(new UserMessageComponent(userText(message.content)));
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const component = this.#streaming ?? new AssistantMessageComponent();
			if (this.#streaming === undefined) this.transcript.addChild(component);
			this.#streaming = undefined;
			component.updateContent(message, false);
			// 只有包含工具调用的回答才会执行调用；已中止、失败或被截断的回答不会执行。
			const ran = message.stopReason === "toolUse";
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const streamed = this.#streamingCalls.has(content.id);
				if (!ran && !streamed) continue;
				const card = this.#tool(content.name, content.id, content.arguments, !streamed);
				card.setArgsComplete();
				if (!ran) {
					const text = "Not run: the answer was interrupted.";
					card.updateResult({ content: [{ type: "text", text }], isError: true }, false);
				}
			}
			this.#streamingCalls.clear();
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const result = message as ToolResultMessage;
			this.#tool(result.toolName, result.toolCallId).updateResult(result);
		} else if (entry.kind === "pi.compaction") {
			this.#addText(theme.fg("muted", "[compaction]"));
			if (message?.role === "user") this.#addText(userText(message.content));
		} else if (entry.kind === "pi.reset") {
			this.#addText(theme.fg("muted", "[new context]"));
		}
	}

	#syncStreaming(message: AssistantMessage): void {
		if (this.#streaming === undefined) {
			this.#streaming = new AssistantMessageComponent();
			this.transcript.addChild(this.#streaming);
		}
		this.#streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#tool(content.name, content.id, content.arguments, !this.#streamingCalls.has(content.id));
			this.#streamingCalls.add(content.id);
		}
	}

	/** 调用对应的卡片；若调用 ID 在较早轮次中用过，`fresh` 会创建新卡片。 */
	#tool(toolName: string, toolCallId: string, args?: unknown, fresh = false): ToolExecutionComponent {
		const existing = fresh ? undefined : this.#tools.get(toolCallId);
		if (existing !== undefined) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args ?? {},
			{},
			ExperimentalChatView.#renderers[toolName],
			this.#ui,
			this.#cwd,
		);
		this.transcript.addChild(component);
		this.#cards.push(component);
		this.#tools.set(toolCallId, component);
		return component;
	}

	#addText(text: string): void {
		this.transcript.addChild(new Spacer(1));
		this.transcript.addChild(new Text(text, 1, 0));
	}
}
