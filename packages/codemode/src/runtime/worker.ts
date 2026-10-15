/**
 * 工作线程入口。每个工作线程都会在全新的 QuickJS 虚拟机（独立的 wasm 实例）中运行一个脚本，
 * 将工具调用和输出转发给宿主，并报告运行结果。脚本结束、超时或被中止时，宿主会终止工作线程；
 * 使用工作线程是为了避免死循环脚本阻塞宿主线程。
 *
 * 导入此模块会启动工作线程。将代码打包的宿主（例如 Bun 编译的可执行文件）需要添加一个文件，
 * 将 `@earendil-works/pi-codemode/worker` 作为独立入口导入，并将该入口的 URL
 * 或内嵌模块字符串说明符作为 `workerUrl` 传入。
 */
import { parentPort, workerData } from "node:worker_threads";
import { JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import { isHostToWorkerMessage, type WorkerData, type WorkerToHostMessage } from "./protocol.ts";

function post(message: WorkerToHostMessage): void {
	parentPort?.postMessage(message);
}

function crash(error: unknown): void {
	post({ type: "crash", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
}

/**
 * QuickJS 会将引擎诊断信息写入文件描述符 1 和 2，默认 shim 会将其转发到宿主的 stdout 和 stderr。
 * 这些输出属于宿主应用（例如 TUI），因此应丢弃。报告所有字节均已写入，可避免 libc 重试。
 */
function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let i = 0; i < iovsLen; i++) {
				written += view.getUint32(iovsPtr + i * 8 + 4, true);
			}
			view.setUint32(nwrittenPtr, written, true);
			return 0;
		},
	};
}

function describeException(error: JSException): string {
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();
	return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${head}\n${stack}` : head });
}

async function main(data: WorkerData): Promise<void> {
	const interrupt = new Int32Array(data.interrupt);
	const vm = await QuickJS.create({
		wasm: data.wasm,
		memoryLimit: data.memoryLimitBytes,
		// 如果没有此限制，深层递归会导致 wasm 栈溢出并触发陷阱，而不是抛出可捕获的 RangeError。
		maxStackSize: MAX_STACK_SIZE,
		interruptHandler: () => Atomics.load(interrupt, 0) !== 0,
		wasi: discardOutput,
	});

	// 由 prelude 调用，参数仅为原始类型。
	const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
		switch (kind.toString()) {
			case "call":
			case "global":
				post({
					type: "call",
					id: a.toNumber(),
					target: kind.toString() === "call" ? "tool" : "global",
					name: b.toString(),
					args: c === undefined || c.isUndefined ? undefined : c.toString(),
				});
				break;
			case "output":
				post({
					type: "output",
					item:
						a.toString() === "image"
							? { type: "image", data: b.toString(), mimeType: c.toString() }
							: a.toString() === "console"
								? { type: "text", text: b.toString(), console: true }
								: { type: "text", text: b.toString() },
				});
				break;
			case "done":
				if (a.toBoolean()) {
					post({
						type: "done",
						ok: true,
						value: b === undefined || b.isUndefined ? undefined : b.toString(),
						writes: c.toString(),
					});
				} else {
					post({ type: "done", ok: false, error: b.toString() });
				}
				break;
		}
		return vm.undefined;
	});

	// 虚拟机会一直存活到宿主终止工作线程，因此这些句柄不会被释放。
	const api = vm.withScope((scope) =>
		scope.escape(
			vm.callFunction(
				vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
				vm.undefined,
				bridge,
				vm.newString(JSON.stringify(data.tools)),
				vm.newString(JSON.stringify(data.globals)),
				vm.newString(JSON.stringify(data.store)),
			),
		),
	);
	const settle = api.getProp("settle");
	const run = api.getProp("run");
	const stalled = api.getProp("stalled");
	/** 运行排队的任务；随后使等待着且永远不会恢复的脚本失败。 */
	const drain = () => {
		vm.executePendingJobs();
		vm.callFunction(stalled, api).dispose();
	};

	parentPort?.on("message", (message: unknown) => {
		if (!isHostToWorkerMessage(message)) return;
		try {
			vm.withScope(() => {
				vm.callFunction(
					settle,
					api,
					vm.newNumber(message.id),
					message.ok ? vm.true : vm.false,
					message.payload === undefined ? vm.undefined : vm.newString(message.payload),
				);
			});
			drain();
		} catch (error) {
			crash(error);
		}
	});

	// 前缀与脚本共用第一行，使报告的行号与脚本原文一致。
	let fn: JSValueHandle;
	try {
		fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
	} catch (error) {
		if (!(error instanceof JSException)) throw error;
		post({ type: "done", ok: false, error: describeException(error) });
		return;
	}
	vm.callFunction(run, api, fn).dispose();
	fn.dispose();
	drain();
}

if (parentPort) {
	main(workerData as WorkerData).catch(crash);
}
