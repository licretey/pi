import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * https://github.com/earendil-works/pi/issues/2791 的回归测试。
 *
 * fs.watch() 返回一个 FSWatcher（EventEmitter）。如果监视器创建后发出
 * 'error' 事件，而又没有注册错误处理器，Node.js 会将其视为未捕获异常并终止进程。
 *
 * 测试会启动子进程并执行以下步骤：
 * 1. 启用监视器并设置自定义主题。
 * 2. 通过 process._getActiveHandles() 查找 FSWatcher。
 * 3. 向该监视器发送模拟的 'error' 事件。
 * 4. 若监视器没有错误处理器，进程会崩溃（退出码非 0），说明问题仍存在。
 * 5. 若监视器注册了错误处理器，进程会正常退出（退出码为 0），说明问题已修复。
 */
describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-2791-"));
		const agentDir = join(tempRoot, "agent");
		const themesDir = join(agentDir, "themes");
		mkdirSync(themesDir, { recursive: true });

		// 将 dark.json 复制为名为 "custom-test" 的主题。
		const darkThemePath = join(__dirname, "../../../src/modes/interactive/theme/dark.json");
		const darkTheme = JSON.parse(readFileSync(darkThemePath, "utf-8"));
		darkTheme.name = "custom-test";
		writeFileSync(join(themesDir, "custom-test.json"), JSON.stringify(darkTheme, null, 2));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("process should survive an error event on the theme FSWatcher", () => {
		const themeModulePath = join(__dirname, "../../../src/modes/interactive/theme/theme.ts").replace(/\\/g, "/");
		const agentDir = join(tempRoot, "agent").replace(/\\/g, "/");

		// 此脚本会创建监视器并向其发送模拟错误。
		// 如果没有注册 .on('error') 处理器，EventEmitter.emit('error')
		// 会抛出异常，从而导致进程崩溃，或被我们的 try/catch 捕获。
		const scriptPath = join(tempRoot, "test-watcher-error.mts");
		writeFileSync(
			scriptPath,
			`
import { setTheme, stopThemeWatcher } from "${themeModulePath}";

process.env.PI_CODING_AGENT_DIR = "${agentDir}";

setTheme("custom-test", true);

		// 在活动句柄中查找 FSWatcher。
const handles = (process as any)._getActiveHandles();
const fsWatcher = handles.find((h: any) => h.constructor?.name === "FSWatcher");

if (!fsWatcher) {
	process.stderr.write("no FSWatcher found among active handles\\n");
	process.exit(2);
}

const errorListenerCount = fsWatcher.listenerCount("error");
if (errorListenerCount === 0) {
	process.stderr.write("BUG: FSWatcher has no error handler (issue #2791)\\n");
}

// EventEmitter 没有错误监听器时，发送 'error' 事件会抛出异常。
// 模拟异步操作系统错误（例如 ReadDirectoryChangesW 失效）。
try {
	fsWatcher.emit("error", new Error("simulated OS watcher failure"));
} catch {
	process.stderr.write("error event was unhandled and threw\\n");
	process.exit(1);
}

stopThemeWatcher();
process.exit(0);
`,
		);

		let _stdout = "";
		let stderr = "";
		let exitCode: number;
		try {
			_stdout = execFileSync(process.execPath, [scriptPath], {
				timeout: 10000,
				encoding: "utf-8",
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				stdio: ["pipe", "pipe", "pipe"],
			});
			exitCode = 0;
		} catch (err: unknown) {
			const e = err as { status: number; stdout: string; stderr: string };
			_stdout = e.stdout ?? "";
			stderr = e.stderr ?? "";
			exitCode = e.status ?? 1;
		}

		expect(exitCode, `Child crashed (exit ${exitCode}). stderr: ${stderr.trim()}`).toBe(0);
	});
});
