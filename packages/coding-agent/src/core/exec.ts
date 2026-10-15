/**
 * 扩展和自定义工具共用的命令执行工具函数。
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * 执行 Shell 命令的选项。
 */
export interface ExecOptions {
	/** 用于取消命令的 AbortSignal。 */
	signal?: AbortSignal;
	/** 超时时间，单位为毫秒。 */
	timeout?: number;
	/** 工作目录。 */
	cwd?: string;
}

/**
 * Shell 命令的执行结果。
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * 执行 Shell 命令并返回 stdout、stderr 和退出码。
 * 支持超时和中止信号。
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// 如果 SIGTERM 未能终止进程，则在 5 秒后强制终止。
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// 处理中止信号。
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// 处理超时。
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// 等待进程终止，同时避免分离的后代进程继承并保持标准 I/O 句柄打开，
		// 从而导致等待一直挂起。
		waitForChildProcess(proc)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
