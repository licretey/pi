import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForChildProcess } from "../../../src/utils/child-process.ts";

/**
 * https://github.com/earendil-works/pi/issues/5303 的回归测试。
 *
 * waitForChildProcess 曾在 `exit` 事件发生时启动固定的 100 毫秒计时器，并在计时器触发时销毁
 * 标准输入输出流。短暂存活的分离子进程若仍占用 stdout 管道，`close` 就不会触发，
 * 此时只能由计时器结束等待；进程退出 100 毫秒后写入的输出都会丢失。实际表现为：
 * 运行 lint-staged 的 git 提交钩子会在 listr2 输出中途被截断，模型则将其判断为卡住。
 *
 * 修复会在每个数据块到达时重新启动宽限期，因此持续写入的管道会让我们
 * 读取；如果句柄确实处于空闲状态，即使仍被占用，也会在宽限期结束后释放。下方使用虚拟时间
 * 覆盖这两种行为，避免主机负载改变真实子进程写入与宽限计时器之间的先后顺序。
 */
describe("issue #5303 bash output truncation past exit", () => {
	function createChild(): ChildProcessByStdio<null, PassThrough, PassThrough> {
		return Object.assign(new EventEmitter(), {
			stdin: null,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		}) as unknown as ChildProcessByStdio<null, PassThrough, PassThrough>;
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("captures output emitted after exit while a descendant holds stdout open", async () => {
		const child = createChild();
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		let resolved = false;
		const waiting = waitForChildProcess(child).then((exitCode) => {
			resolved = true;
			return exitCode;
		});

		child.stdout.write("HEAD\n");
		child.emit("exit", 0, null);
		for (let index = 1; index <= 6; index++) {
			await vi.advanceTimersByTimeAsync(50);
			child.stdout.write(`TICK${index}\n`);
		}
		await vi.advanceTimersByTimeAsync(99);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(await waiting).toBe(0);
		expect(output).toContain("HEAD");
		expect(output).toContain("TICK6");
	});

	it("resolves after the grace when a descendant holds stdout open but stays quiet", async () => {
		const child = createChild();
		let resolved = false;
		const waiting = waitForChildProcess(child).then((exitCode) => {
			resolved = true;
			return exitCode;
		});

		child.stdout.write("DONE\n");
		child.emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(99);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(await waiting).toBe(0);
	});
});
