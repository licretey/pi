/**
 * TUI 视口内容被覆盖问题的复现示例。
 *
 * 文件路径：packages/tui/test/viewport-overwrite-repro.ts
 * 在仓库根目录运行：node packages/tui/test/viewport-overwrite-repro.ts
 *
 * 为稳定复现问题，请在较小的终端（8-12 行）或 tmux 会话中运行：
 *   tmux new-session -d -s tui-bug -x 80 -y 12
 *   tmux send-keys -t tui-bug "node packages/tui/test/viewport-overwrite-repro.ts" Enter
 *   tmux attach -t tui-bug
 *
 * 预期行为：
 * - PRE-TOOL 行保留在工具输出上方。
 * - POST-TOOL 行追加在工具输出之后，不覆盖此前内容。
 *
 * 实际行为（问题）：
 * - 内容超出视口后，工具调用暂停结束并收到新行时，底部附近的部分 PRE-TOOL 行会被 POST-TOOL 行覆盖。
 */

import { ProcessTerminal } from "../src/terminal.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class Lines implements Component {
	private lines: string[] = [];

	set(lines: string[]): void {
		this.lines = lines;
	}

	append(lines: string[]): void {
		this.lines.push(...lines);
	}

	render(width: number): string[] {
		return this.lines.map((line) => {
			if (line.length > width) return line.slice(0, width);
			return line.padEnd(width, " ");
		});
	}

	invalidate(): void {}
}

async function streamLines(buffer: Lines, label: string, count: number, delayMs: number, ui: TUI): Promise<void> {
	for (let i = 1; i <= count; i += 1) {
		buffer.append([`${label} ${String(i).padStart(2, "0")}`]);
		ui.requestRender();
		await sleep(delayMs);
	}
}

async function main(): Promise<void> {
	const ui: TUI = new TuiMainScreen(new ProcessTerminal());
	const buffer = new Lines();
	ui.addChild(buffer);
	ui.start();

	const height = ui.terminal.rows;
	const preCount = height + 8; // 确保内容超出视口高度。
	const toolCount = height + 12; // 工具输出会进一步占用回滚缓冲区。
	const postCount = 6;

	buffer.set([
		"TUI viewport overwrite repro",
		`Viewport rows detected: ${height}`,
		"(Resize to ~8-12 rows for best repro)",
		"",
		"=== PRE-TOOL STREAM ===",
	]);
	ui.requestRender();
	await sleep(300);

	// 阶段 1：持续输出工具调用前的文本，直到内容超出视口。
	await streamLines(buffer, "PRE-TOOL LINE", preCount, 30, ui);

	// 阶段 2：模拟工具调用暂停及工具输出。
	buffer.append(["", "--- TOOL CALL START ---", "(pause...)", ""]);
	ui.requestRender();
	await sleep(700);

	await streamLines(buffer, "TOOL OUT", toolCount, 20, ui);

	// 阶段 3：持续输出工具调用后的文本，覆盖问题通常在此出现。
	buffer.append(["", "=== POST-TOOL STREAM ==="]);
	ui.requestRender();
	await sleep(300);
	await streamLines(buffer, "POST-TOOL LINE", postCount, 40, ui);

	// 暂时保留输出供查看，然后恢复终端状态。
	await sleep(1500);
	ui.stop();
}

main().catch((error) => {
	// 出错时也要确保终端状态得到恢复。
	try {
		const ui: TUI = new TuiMainScreen(new ProcessTerminal());
		ui.stop();
	} catch {
		// 忽略恢复终端状态时发生的错误。
	}
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
});
