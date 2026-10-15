import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../../../src/config.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// https://github.com/earendil-works/pi/issues/5080 的回归测试。
//
// 收到 SIGTERM/SIGHUP 时，正常关闭必须先发出 `session_shutdown`（调用 runtimeHost.dispose），再操作终端。
// 扩展清理（例如移除套接字）不会向 tty 写入内容，因此即使之后恢复终端时写入失败
// （终端已断开或无响应），也必须先完成扩展清理。交互模式的退出方式（Ctrl+D、/quit）则保持相反顺序，
// 以保留 TUI 的最后一帧画面。

type ShutdownThis = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	runtimeHost: { dispose: () => Promise<void> };
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
	sessionManager: SessionManager;
};

type InteractiveModePrototypeWithShutdown = {
	shutdown(this: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;
const tempDirs: string[] = [];
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

class ProcessExitError extends Error {
	readonly code: number | undefined;
	constructor(code?: number) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

function createSessionManager(options: { sessionFile?: string } = {}): SessionManager {
	return {
		isPersisted: () => options.sessionFile !== undefined,
		getSessionFile: () => options.sessionFile,
		getSessionId: () => "test-session",
		getSessionDir: () => "/tmp/pi-sessions",
		usesDefaultSessionDir: () => true,
	} as unknown as SessionManager;
}

function createTempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-shutdown-resume-hint-"));
	tempDirs.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "\n");
	return file;
}

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreStdoutIsTTY(): void {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
}

function createContext(order: string[], sessionManager = createSessionManager()): ShutdownThis {
	return {
		isShuttingDown: false,
		unregisterSignalHandlers: vi.fn(),
		runtimeHost: {
			dispose: vi.fn(async () => {
				order.push("dispose");
			}),
		},
		ui: {
			terminal: {
				drainInput: vi.fn(async () => {
					order.push("drainInput");
				}),
			},
		},
		themeController: { disableAutoSync: vi.fn() },
		stop: vi.fn(() => {
			order.push("stop");
		}),
		sessionManager,
	};
}

async function callShutdown(context: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(context, options);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

describe("InteractiveMode.shutdown ordering (#5080)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("signal-triggered shutdown emits session_shutdown before terminal writes", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual(["dispose", "drainInput", "stop"]);
		expect(context.isShuttingDown).toBe(true);
	});

	test("interactive quit stops the TUI before emitting session_shutdown", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
	});

	test("interactive quit prints a resume hint for persisted sessions", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
		expect(stdoutWrite).toHaveBeenCalledWith(
			`${chalk.dim("To resume this session:")} ${APP_NAME} --session test-session\n`,
		);
	});

	test("signal-triggered shutdown does not print a resume hint", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context, { fromSignal: true });

		for (const call of stdoutWrite.mock.calls) {
			expect(call[0]).not.toContain("To resume this session:");
		}
	});

	test("re-entrant shutdown is a no-op", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);
		context.isShuttingDown = true;

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual([]);
		expect(context.runtimeHost.dispose).not.toHaveBeenCalled();
	});
});

// 针对 `read EIO` 崩溃报告（crash_tty_read_eio）的回归测试。
//
// 终端消失后，从 stdin 读取数据和调用 setRawMode 都会因 EIO 失败（pi 会
// 进程可能遗留在孤立的后台进程组中，或因 macOS 撤销 tty 而触发 ENOTTY。Node 会将这些错误
// 作为 `error` 事件发送到 process.stdin。若没有 stdin 监听器，它们会成为未捕获异常，
// 被记录为崩溃，并提示用户下次启动时运行 /bug。

type HandlerContext = {
	isShuttingDown: boolean;
	signalCleanupHandlers: Array<() => void>;
	shutdown: () => Promise<void>;
	unregisterSignalHandlers: () => void;
	emergencyTerminalExit: () => never;
	uncaughtCrash: (error: Error) => never;
	recordCrash: () => boolean;
	getCrashExtensionHint: () => string | undefined;
	crashReportInstructions: () => string;
	ui: { stop: () => void };
};

type InteractiveModePrivates = {
	registerSignalHandlers(this: HandlerContext): void;
	unregisterSignalHandlers(this: HandlerContext): void;
	emergencyTerminalExit(this: HandlerContext): never;
	uncaughtCrash(this: HandlerContext, error: Error): never;
};

const proto = InteractiveMode.prototype as unknown as InteractiveModePrivates;

function createHandlerContext(): HandlerContext {
	const context: HandlerContext = {
		isShuttingDown: false,
		signalCleanupHandlers: [],
		shutdown: vi.fn(async () => {}),
		unregisterSignalHandlers: () => proto.unregisterSignalHandlers.call(context),
		emergencyTerminalExit: () => proto.emergencyTerminalExit.call(context),
		uncaughtCrash: (error: Error) => proto.uncaughtCrash.call(context, error),
		recordCrash: vi.fn(() => true),
		getCrashExtensionHint: () => undefined,
		crashReportInstructions: () => "",
		ui: { stop: vi.fn() },
	};
	return context;
}

function errnoError(message: string, code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

function captureExit(fn: () => void): number | undefined {
	try {
		fn();
	} catch (error) {
		if (error instanceof ProcessExitError) return error.code;
		throw error;
	}
	throw new Error("expected process.exit");
}

describe("dead terminal errors on stdin", () => {
	let context: HandlerContext | undefined;

	afterEach(() => {
		context?.unregisterSignalHandlers();
		context = undefined;
		vi.restoreAllMocks();
	});

	function setup(): HandlerContext {
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitError(code);
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation(() => {});
		context = createHandlerContext();
		proto.registerSignalHandlers.call(context);
		return context;
	}

	test.each([
		["read EIO", "EIO"],
		["setRawMode EIO", "EIO"],
		["setRawMode ENOTTY", "ENOTTY"],
	])("stdin %s exits quietly without recording a crash", (message, code) => {
		const ctx = setup();

		const exitCode = captureExit(() => process.stdin.emit("error", errnoError(message, code)));

		expect(exitCode).toBe(129);
		expect(ctx.recordCrash).not.toHaveBeenCalled();
		expect(ctx.ui.stop).not.toHaveBeenCalled();
	});

	test("other stdin errors still crash", () => {
		setup();
		const error = errnoError("read ECONNREFUSED", "ECONNREFUSED");

		expect(() => process.stdin.emit("error", error)).toThrow(error);
	});

	test("uncaught dead terminal errors are not recorded as crashes", () => {
		const ctx = setup();

		const exitCode = captureExit(() => ctx.uncaughtCrash(errnoError("read EIO", "EIO")));

		expect(exitCode).toBe(129);
		expect(ctx.recordCrash).not.toHaveBeenCalled();
	});

	test("other uncaught errors are still recorded as crashes", () => {
		const ctx = setup();

		const exitCode = captureExit(() => ctx.uncaughtCrash(new Error("boom")));

		expect(exitCode).toBe(1);
		expect(ctx.recordCrash).toHaveBeenCalledOnce();
	});

	test("handlers are removed on unregister", () => {
		const ctx = setup();
		const before = process.stdin.listenerCount("error");

		ctx.unregisterSignalHandlers();

		expect(process.stdin.listenerCount("error")).toBe(before - 1);
	});
});
