import { type Component, Container, getKeybindings, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

interface UserMessageItem {
	id: string; // 会话中的条目 ID。
	text: string; // 消息文本。
	timestamp?: string; // 可选时间戳；有值时提供。
}

/**
 * 可供选择的自定义用户消息列表组件。
 */
class UserMessageList implements Component {
	private messages: UserMessageItem[] = [];
	private selectedIndex: number = 0;
	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	private maxVisible: number = 10; // Max messages visible

	constructor(messages: UserMessageItem[], initialSelectedId?: string) {
		// 按时间顺序保存消息（从最早到最新）。
		this.messages = messages;
		const initialIndex = initialSelectedId ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		// 若提供了选中的消息，则从该消息开始；否则默认选择最新消息。
		this.selectedIndex = initialIndex >= 0 ? initialIndex : Math.max(0, messages.length - 1);
	}

	invalidate(): void {
		// 当前没有需要失效处理的缓存状态。
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		// 根据滚动位置计算可见范围。
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.messages.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.messages.length);

		// 渲染可见消息（每条消息占两行，之后空一行）。
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.messages[i];
			const isSelected = i === this.selectedIndex;

			// 将消息规整为单行。
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// 第一行：光标和消息。
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const maxMsgWidth = width - 2; // 为光标预留两列。
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			lines.push(messageLine);

			// 第二行：元数据（消息在历史记录中的位置）。
			const position = i + 1;
			const metadata = `  Message ${position} of ${this.messages.length}`;
			const metadataLine = theme.fg("muted", metadata);
			lines.push(metadataLine);
			lines.push(""); // 在消息之间插入空行。
		}

		// 必要时添加滚动指示器。
		if (startIndex > 0 || endIndex < this.messages.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.messages.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// 按上方向键转到上一条（更早的）消息；位于顶部时循环到列表底部。
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		}
		// 按下方向键转到下一条（更新的）消息；位于底部时循环到列表顶部。
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// 按 Enter 选择消息并创建分支。
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.messages[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
		// 按 Escape 取消。
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

/**
 * 渲染用于创建分支的用户消息选择器。
 */
export class UserMessageSelectorComponent extends Container {
	private messageList: UserMessageList;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
	) {
		super();

		// 添加标题。
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Fork from Message"), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Select a user message to copy the active path up to that point into a new session"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// 创建消息列表。
		this.messageList = new UserMessageList(messages, initialSelectedId);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;

		this.addChild(this.messageList);

		// 添加下边框。
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// 没有消息时自动取消。
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): UserMessageList {
		return this.messageList;
	}
}
