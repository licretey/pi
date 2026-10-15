import { spawn } from "node:child_process";

/** 返回 undefined 表示命令失败；空缓冲区表示命令成功但没有输出。 */
export function runClipboardCommand(
	command: string,
	args: readonly string[],
	options?: { input?: string; timeoutMs?: number; maxBufferBytes?: number },
): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		// 剪贴板写入程序可能会转为守护进程运行，不要向其提供可能被持续占用的输出管道。
		const child = spawn(command, args, {
			stdio: ["pipe", options?.input === undefined ? "pipe" : "ignore", "ignore"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let length = 0;
		let settled = false;
		const finish = (result: Buffer | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const abort = (): void => {
			child.kill("SIGKILL");
			child.stdout?.destroy();
			child.stdin?.destroy();
			finish(undefined);
		};
		const timer = setTimeout(abort, options?.timeoutMs ?? 3000);
		child.on("error", () => finish(undefined));
		child.on("close", (code) => {
			if (!settled) finish(code === 0 ? Buffer.concat(chunks, length) : undefined);
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			length += chunk.length;
			if (length > (options?.maxBufferBytes ?? 50 * 1024 * 1024)) abort();
			else chunks.push(chunk);
		});
		child.stdin?.on("error", () => {}); // 写入程序可能会在读取完所有输入前退出。
		child.stdin?.end(options?.input);
	});
}
