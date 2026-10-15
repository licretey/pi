/**
 * 交互式 Shell 命令扩展
 *
 * 支持在完整终端访问权限下运行交互式命令（vim、git rebase -i、htop 等）。
 * 命令运行期间，TUI 会暂停。
 *
 * 用法：
 *   pi -e examples/extensions/interactive-shell.ts
 *
 *   !vim file.txt        # 自动识别为交互式命令
 *   !i any-command       # 使用 !i 前缀强制进入交互模式
 *   !git rebase -i HEAD~3
 *   !htop
 *
 * 通过环境变量配置：
 *   INTERACTIVE_COMMANDS - 额外的命令（以逗号分隔）
 *   INTERACTIVE_EXCLUDE  - 要排除的命令（以逗号分隔）
 *
 * 注意：此扩展只拦截用户输入的 `!` 命令，不拦截 agent 的 bash 工具调用。
 * agent 运行交互式命令时会失败，这是预期行为。
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 默认交互式命令：编辑器、分页器、Git 操作和 TUI
const DEFAULT_INTERACTIVE_COMMANDS = [
	// 编辑器
	"vim",
	"nvim",
	"vi",
	"nano",
	"emacs",
	"pico",
	"micro",
	"helix",
	"hx",
	"kak",
	// 分页器
	"less",
	"more",
	"most",
	// 交互式 Git 命令
	"git commit",
	"git rebase",
	"git merge",
	"git cherry-pick",
	"git revert",
	"git add -p",
	"git add --patch",
	"git add -i",
	"git add --interactive",
	"git stash -p",
	"git stash --patch",
	"git reset -p",
	"git reset --patch",
	"git checkout -p",
	"git checkout --patch",
	"git difftool",
	"git mergetool",
	// 系统监视器
	"htop",
	"top",
	"btop",
	"glances",
	// 文件管理器
	"ranger",
	"nnn",
	"lf",
	"mc",
	"vifm",
	// Git TUI
	"tig",
	"lazygit",
	"gitui",
	// 模糊查找工具
	"fzf",
	"sk",
	// 远程会话
	"ssh",
	"telnet",
	"mosh",
	// 数据库客户端
	"psql",
	"mysql",
	"sqlite3",
	"mongosh",
	"redis-cli",
	// Kubernetes/Docker 工具
	"kubectl edit",
	"kubectl exec -it",
	"docker exec -it",
	"docker run -it",
	// 其他
	"tmux",
	"screen",
	"ncdu",
];

function getInteractiveCommands(): string[] {
	const additional =
		process.env.INTERACTIVE_COMMANDS?.split(",")
			.map((s) => s.trim())
			.filter(Boolean) ?? [];
	const excluded = new Set(process.env.INTERACTIVE_EXCLUDE?.split(",").map((s) => s.trim().toLowerCase()) ?? []);
	return [...DEFAULT_INTERACTIVE_COMMANDS, ...additional].filter((cmd) => !excluded.has(cmd.toLowerCase()));
}

function isInteractiveCommand(command: string): boolean {
	const trimmed = command.trim().toLowerCase();
	const commands = getInteractiveCommands();

	for (const cmd of commands) {
		const cmdLower = cmd.toLowerCase();
		// 匹配命令开头
		if (trimmed === cmdLower || trimmed.startsWith(`${cmdLower} `) || trimmed.startsWith(`${cmdLower}\t`)) {
			return true;
		}
		// 匹配管道符后的命令，例如 "cat file | less"
		const pipeIdx = trimmed.lastIndexOf("|");
		if (pipeIdx !== -1) {
			const afterPipe = trimmed.slice(pipeIdx + 1).trim();
			if (afterPipe === cmdLower || afterPipe.startsWith(`${cmdLower} `)) {
				return true;
			}
		}
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	pi.on("user_bash", async (event, ctx) => {
		let command = event.command;
		let forceInteractive = false;

		// 检查 !i 前缀（传入的 command 不包含开头的 !）
		// 前缀会在触发此事件前解析，因此这里检查 command 是否以 "i " 开头
		if (command.startsWith("i ") || command.startsWith("i\t")) {
			forceInteractive = true;
			command = command.slice(2).trim();
		}

		const shouldBeInteractive = forceInteractive || isInteractiveCommand(command);
		if (!shouldBeInteractive) {
			return; // 继续执行常规处理。
		}

		// 当前没有可用 UI（例如打印模式或 RPC 模式）
		if (ctx.mode !== "tui") {
			return {
				result: { output: "(interactive commands require TUI)", exitCode: 1, cancelled: false, truncated: false },
			};
		}

		// 使用 ctx.ui.custom() 获取 TUI，然后运行命令
		const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
			// 停止 TUI，以释放终端
			tui.stop();

			// 清屏
			process.stdout.write("\x1b[2J\x1b[H");

			// 在获得完整终端访问权限后运行命令
			const shell = process.env.SHELL || "/bin/sh";
			const result = spawnSync(shell, ["-c", command], {
				stdio: "inherit",
				env: process.env,
			});

			// 重新启动 TUI
			tui.start();
			tui.requestRender(true);

			// 通知操作已完成
			done(result.status);

			// 返回空组件（done() 已调用，因此该组件会立即释放）
			return { render: () => [], invalidate: () => {} };
		});

		// 返回结果，阻止默认的 bash 处理逻辑
		const output =
			exitCode === 0
				? "(interactive command completed successfully)"
				: `(interactive command exited with code ${exitCode})`;

		return {
			result: {
				output,
				exitCode: exitCode ?? 1,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
