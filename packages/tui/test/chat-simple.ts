/**
 * 使用 tui.ts 实现的简单聊天界面示例。
 */

import chalk from "chalk";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { Loader } from "../src/components/loader.ts";
import { Markdown } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme, defaultMarkdownTheme } from "./test-themes.ts";

// 创建终端。
const terminal = new ProcessTerminal();

// 创建 TUI。
const tui: TUI = new TuiMainScreen(terminal);

// 创建聊天容器并添加初始消息。
tui.addChild(
	new Text("Welcome to Simple Chat!\n\nType your messages below. Type '/' for commands. Press Ctrl+C to exit."),
);

// 创建带自动补全功能的编辑器。
const editor = new Editor(tui, defaultEditorTheme);

// 配置自动补全提供器，支持斜杠命令和文件补全。
const autocompleteProvider = new CombinedAutocompleteProvider(
	[
		{ name: "delete", description: "Delete the last message" },
		{ name: "clear", description: "Clear all messages" },
	],
	process.cwd(),
);
editor.setAutocompleteProvider(autocompleteProvider);

tui.addChild(editor);

// 将焦点设为编辑器。
tui.setFocus(editor);

// 记录是否正在等待机器人回复。
let isResponding = false;

// 处理消息提交。
editor.onSubmit = (value: string) => {
	// 如果正在等待回复，则阻止再次提交。
	if (isResponding) {
		return;
	}

	const trimmed = value.trim();

	// 处理斜杠命令。
	if (trimmed === "/delete") {
		const children = tui.children;
		// 移除编辑器之前的组件（初始文本之外若还有其他组件）。
		if (children.length > 3) {
			// children[0] = 欢迎文本。
			// children[1] = 输入提示文本。
			// children[2...n-1] = 聊天消息。
			// children[n] = 编辑器。
			children.splice(children.length - 2, 1);
		}
		tui.requestRender();
		return;
	}

	if (trimmed === "/clear") {
		const children = tui.children;
		// 移除所有聊天消息，保留欢迎文本和编辑器。
		children.splice(2, children.length - 3);
		tui.requestRender();
		return;
	}

	if (trimmed) {
		isResponding = true;
		editor.disableSubmit = true;

		const userMessage = new Markdown(value, 1, 1, defaultMarkdownTheme);

		const children = tui.children;
		children.splice(children.length - 1, 0, userMessage);

		const loader = new Loader(
			tui,
			(s) => chalk.cyan(s),
			(s) => chalk.dim(s),
			"Thinking...",
		);
		children.splice(children.length - 1, 0, loader);

		tui.requestRender();

		setTimeout(() => {
			tui.removeChild(loader);

			// 模拟一条回复。
			const responses = [
				"That's interesting! Tell me more.",
				"I see what you mean.",
				"Fascinating perspective!",
				"Could you elaborate on that?",
				"That makes sense to me.",
				"I hadn't thought of it that way.",
				"Great point!",
				"Thanks for sharing that.",
			];
			const randomResponse = responses[Math.floor(Math.random() * responses.length)];

			// 添加无背景（透明）的助手消息。
			const botMessage = new Markdown(randomResponse, 1, 1, defaultMarkdownTheme);
			children.splice(children.length - 1, 0, botMessage);

			// 重新启用提交。
			isResponding = false;
			editor.disableSubmit = false;

			// 请求重新渲染。
			tui.requestRender();
		}, 1000);
	}
};

// 启动 TUI。
tui.start();
