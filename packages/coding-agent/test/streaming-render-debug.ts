/**
 * 用于复现流式渲染问题的调试脚本。
 * 使用曾触发该问题的真实测试数据。
 * 运行方式：node --import ./src/experimental/source-resolver.ts test/streaming-render-debug.ts
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProcessTerminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 初始化深色主题并启用完整色彩支持。
process.env.COLORTERM = "truecolor";
initTheme("dark");

// 加载曾触发该问题的真实测试数据。
const fixtureMessage: AssistantMessage = JSON.parse(
	readFileSync(join(__dirname, "fixtures/assistant-message-with-thinking-code.json"), "utf-8"),
);

// 提取思考内容和文本内容。
const thinkingContent = fixtureMessage.content.find((c) => c.type === "thinking");
const textContent = fixtureMessage.content.find((c) => c.type === "text");

if (!thinkingContent || thinkingContent.type !== "thinking") {
	console.error("No thinking content in fixture");
	process.exit(1);
}

const fullThinkingText = thinkingContent.thinking;
const fullTextContent = textContent && textContent.type === "text" ? textContent.text : "";

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
	const terminal = new ProcessTerminal();
	const tui: TUI = new TuiMainScreen(terminal);

	// 从空消息开始。
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "" }],
	} as AssistantMessage;

	const component = new AssistantMessageComponent(message, false);
	tui.addChild(component);
	tui.start();

	// 模拟思考内容的流式输出。
	let thinkingBuffer = "";
	const chunkSize = 10; // 每个“令牌”包含的字符数。

	for (let i = 0; i < fullThinkingText.length; i += chunkSize) {
		thinkingBuffer += fullThinkingText.slice(i, i + chunkSize);

		// 更新消息内容。
		const updatedMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: thinkingBuffer }],
		} as AssistantMessage;

		component.updateContent(updatedMessage);
		tui.requestRender();

		await sleep(15); // 模拟令牌间隔。
	}

	// 接着添加文本内容。
	await sleep(500);

	const finalMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: fullThinkingText },
			{ type: "text", text: fullTextContent },
		],
	} as AssistantMessage;

	component.updateContent(finalMessage);
	tui.requestRender();

	// 暂停片刻，以便观察结果。
	await sleep(3000);

	tui.stop();
	process.exit(0);
}

main().catch(console.error);
