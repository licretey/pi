import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * 在 PATH 中查找 Bash 可执行文件（跨平台）。
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		// Windows：使用 `where` 查找，并确认文件确实存在（`where` 可能返回不存在的路径）。
		try {
			const result = spawnSync("where", [executable], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// 忽略错误。
		}
		return null;
	}

	// Unix：使用 `which` 并信任其输出（兼容 Termux 和特殊文件系统）。
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// 忽略错误。
	}
	return null;
}

/**
 * 根据平台和可选的显式 Shell 路径解析 Shell 配置。
 * 查找顺序：
 * 1. 用户指定的 shellPath
 * 2. Windows：先查找已知位置的 Git Bash，再查找 PATH 中的 Bash
 * 3. Unix：先查找 /bin/bash，再查找 PATH 中的 Bash，最后回退到 sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. 检查用户指定的 Shell 路径
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. 在已知位置查找 Git Bash
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. 回退方案：在 PATH 中查找 bash.exe（Cygwin、MSYS2、WSL 等）
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix：先尝试 /bin/bash，再查找 PATH 中的 Bash，最后回退到 sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/** 在 Windows 上解析 PowerShell 路径；若可用，优先使用 PowerShell 7。 */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * 清理二进制输出，使其适合显示或存储。
 * 移除会导致 string-width 崩溃或显示异常的字符：
 * - 控制字符（保留制表符、换行符和回车符）
 * - Unicode 行间注释字符 U+FFF9..U+FFFB（因 string-width 的缺陷会导致崩溃）
 */
export function sanitizeBinaryOutput(str: string): string {
	// 被移除的字符均为单个 UTF-16 代码单元，因此不会拆开代理对。
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

/**
 * 必须跟踪脱离父进程的子进程，以便在父进程收到
 * 关闭信号（SIGHUP/SIGTERM）时将其终止。
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * 终止进程及其所有子进程（跨平台）。
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// 使用可信的 System32 可执行文件，避免清理操作依赖 PATH。
		try {
			const child = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{
					stdio: "ignore",
					detached: true,
					windowsHide: true,
				},
			);
			// spawn 失败时会异步发出 "error"；在此处理该事件，避免 Node 崩溃。
			child.once("error", () => {});
		} catch {
			// taskkill 执行失败时忽略错误。
		}
	} else {
		// 在 Unix/Linux/macOS 上使用 SIGKILL。
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// 进程组终止失败时，回退为仅终止子进程。
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// 进程已退出。
			}
		}
	}
}
