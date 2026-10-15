import { spawn } from "node:child_process";

/**
 * 使用平台浏览器或默认处理程序打开 URL 或文件。
 *
 * 此函数刻意不调用 Shell。在 Windows 上不要使用 `cmd /c start`：cmd.exe 会在执行
 * `start` 前重新解析元字符（&、|、^ 等），导致攻击者可控的 URL 被注入命令。
 */
export function openBrowser(target: string): void {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	// spawn 会通过 error 事件报告启动器错误（例如找不到 xdg-open）。浏览器启动采用尽力而为策略：
	// 即使启动器失败，调用方仍会向用户显示目标地址，因此需要避免此错误导致进程崩溃。
	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
