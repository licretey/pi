#!/usr/bin/env node
import { matchesKey } from "../src/keys.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { truncateToWidth } from "../src/utils.ts";

/**
 * 简单的按键编码记录组件。
 */
class KeyLogger implements Component {
	private log: string[] = [];
	private maxLines = 20;
	private tui: TUI;
	private terminal: ProcessTerminal;

	constructor(tui: TUI, terminal: ProcessTerminal) {
		this.tui = tui;
		this.terminal = terminal;
	}

	handleInput(data: string): void {
		// 处理 Ctrl+C（原始输入或 Kitty 协议输入）以退出。
		if (matchesKey(data, "ctrl+c")) {
			this.tui.stop();
			console.log("\nExiting...");
			process.exit(0);
		}

		// 将输入转换为多种表示形式。
		const hex = Buffer.from(data).toString("hex");
		const charCodes = Array.from(data)
			.map((c) => c.charCodeAt(0))
			.join(", ");
		const repr = data
			.replace(/\x1b/g, "\\x1b")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			.replace(/\x7f/g, "\\x7f");

		const logLine = `Hex: ${hex.padEnd(20)} | Chars: [${charCodes.padEnd(15)}] | Repr: "${repr}"`;

		this.log.push(logLine);

		// 仅保留最后 N 行。
		if (this.log.length > this.maxLines) {
			this.log.shift();
		}

		// 请求重新渲染以显示新日志。
		this.tui.requestRender();
	}

	invalidate(): void {
		// 当前没有需要失效处理的缓存状态。
	}

	private protocolName(): string {
		if (this.terminal.kittyProtocolActive) return "kitty";
		if (this.terminal.modifyOtherKeysActive) return "modifyOtherKeys";
		return "legacy";
	}

	private fit(line: string, width: number): string {
		return truncateToWidth(line, width).padEnd(width);
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// 标题。
		lines.push("=".repeat(width));
		lines.push(this.fit("Key Code Tester - Press keys to see their codes (Ctrl+C to exit)", width));
		lines.push(this.fit(`Protocol: ${this.protocolName()}`, width));
		lines.push("=".repeat(width));
		lines.push("");

		// 日志条目。
		for (const entry of this.log) {
			lines.push(this.fit(entry, width));
		}

		// 填充剩余空间。
		const remaining = Math.max(0, 25 - lines.length);
		for (let i = 0; i < remaining; i++) {
			lines.push("".padEnd(width));
		}

		// 页脚。
		lines.push("=".repeat(width));
		lines.push(this.fit("Test these:", width));
		lines.push(this.fit("  - Shift + Enter (should show: \\x1b[13;2u with Kitty protocol)", width));
		lines.push(this.fit("  - Alt/Option + Enter", width));
		lines.push(this.fit("  - Option/Alt + Backspace", width));
		lines.push(this.fit("  - Cmd/Ctrl + Backspace", width));
		lines.push(this.fit("  - Regular Backspace", width));
		lines.push("=".repeat(width));

		return lines;
	}
}

// 初始化 TUI。
const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);
const logger = new KeyLogger(tui, terminal);

tui.addChild(logger);
tui.setFocus(logger);

// 处理 Ctrl+C 以正常退出（原始模式下 SIGINT 仍然有效）。
process.on("SIGINT", () => {
	tui.stop();
	console.log("\nExiting...");
	process.exit(0);
});

// 启动 TUI。
tui.start();

// 协议协商会在首次渲染后异步完成。
// 短暂地持续刷新，避免界面显示的协议状态过期。
setInterval(() => tui.requestRender(), 100);
