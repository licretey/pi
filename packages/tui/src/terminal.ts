import * as fs from "node:fs";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys.ts";
import { isNativeModifierPressed } from "./native-modifiers.ts";
import { getNativePlatformHelper } from "./native-platform.ts";
import {
	formatProgramStatus,
	isProgramStatusReply,
	PROGRAM_STATUS_QUERY,
	type ProgramStatus,
} from "./program-status.ts";
import { StdinBuffer } from "./stdin-buffer.ts";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";
const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u`;
const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";

export type KeyboardProtocolNegotiationSequence =
	| { type: "kitty-flags"; flags: number }
	| { type: "device-attributes" };

export function parseKeyboardProtocolNegotiationSequence(
	sequence: string,
): KeyboardProtocolNegotiationSequence | undefined {
	const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
	if (kittyFlags) {
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1]!, 10) };
	}
	if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
		return { type: "device-attributes" };
	}
	return undefined;
}

function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}

/**
 * 在 POSIX 平台上向本进程发送 SIGWINCH 以刷新终端尺寸。
 * 尽力而为：某些环境（受限的 seccomp 或 LSM 策略）调用 `kill(2)` 会返回 EACCES，
 * 此时跳过尺寸刷新而不是崩溃。
 */
export function refreshTerminalDimensions(): void {
	if (process.platform === "win32" || process.pid <= 0) return;
	try {
		process.kill(process.pid, "SIGWINCH");
	} catch {
		// 此环境不允许发送信号；忽略。
	}
}

export function normalizeNativeShiftEnterInput(
	data: string,
	shouldDetectNativeShiftEnter: boolean,
	isShiftPressed: boolean,
): string {
	if (shouldDetectNativeShiftEnter && data === "\r" && isShiftPressed) return NATIVE_SHIFT_ENTER_SEQUENCE;
	return data;
}

export function normalizeAppleTerminalInput(data: string, isAppleTerminal: boolean, isShiftPressed: boolean): string {
	return normalizeNativeShiftEnterInput(data, isAppleTerminal, isShiftPressed);
}

/**
 * TUI 所需的最小终端接口
 */
export interface Terminal {
	// 启动终端并挂载输入与 resize 处理器
	start(onInput: (data: string) => void, onResize: () => void): void;

	// 停止终端并恢复原有状态
	stop(): void;

	/**
	 * 退出前先排空 stdin，防止 Kitty 按键释放事件在慢速 SSH 连接上
	 * 泄漏到父 shell。
	 * @param maxMs - 排空的最长时间（默认：1000ms）
	 * @param idleMs - 超过该时间仍无输入则提前结束（默认：50ms）
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// 向终端写入输出
	write(data: string): void;

	// 获取终端尺寸
	get columns(): number;
	get rows(): number;

	// Kitty 键盘协议是否处于激活状态。
	get kittyProtocolActive(): boolean;

	// 光标定位（相对当前位置）
	moveBy(lines: number): void; // 将光标上移（负数）或下移（正数）N 行

	// 光标可见性
	hideCursor(): void; // 隐藏光标
	showCursor(): void; // 显示光标

	// 清除操作
	clearLine(): void; // 清除当前行
	clearFromCursor(): void; // 清除从光标到屏幕末尾的内容
	clearScreen(): void; // 清除整个屏幕并把光标移到 (0,0)

	// 标题操作
	setTitle(title: string): void; // 设置终端窗口标题

	// 进度指示器（OSC 9;4）
	setProgress(active: boolean): void;

	/**
	 * 上报程序当前正在做什么（OSC 7501）。只发给支持该特性的终端；当支持被确认
	 * 或终端重启后，会重新发送最新状态。
	 */
	setProgramStatus(status: ProgramStatus): void;
}

const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;

/**
 * 决定在把孤立 ESC 当作 Escape 键分发之前，等待转义序列剩余部分的时长。
 * 旧式 Alt+按键输入是 ESC 加另一个字节，因此高延迟的传输层需要更长的重组窗口。
 */
export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PI_TUI_ESC_TIMEOUT);
	if (Number.isFinite(configured) && configured > 0) {
		return configured;
	}
	if (env.SSH_CONNECTION || env.SSH_TTY) {
		return DEFAULT_SSH_ESCAPE_TIMEOUT_MS;
	}
	return DEFAULT_ESCAPE_TIMEOUT_MS;
}

/**
 * 基于 process.stdin/stdout 的真实终端
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private keyboardProtocolPushed = false;
	/** 尚欠 DA1 回复的 keyboard protocol 查询数。后续到来的 DA1 回复若超出此数，则属于其他查询，会被转发。 */
	private pendingKeyboardProtocolDeviceAttributes = 0;
	private keyboardProtocolNegotiationBuffer = "";
	private keyboardProtocolBufferFlushTimer?: ReturnType<typeof setTimeout>;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	/** 最近一次的程序状态，跨 stop() 保留，以便 start() 时重新上报。 */
	private programStatus?: ProgramStatus;
	/** 自上次 start() 以来终端是否确认支持 OSC 7501，或设置了 `PI_PROGRAM_STATUS=1`。 */
	private programStatusSupported = false;
	/** 支持查询已发送，其 DA1 哨兵响应尚未到达。 */
	private programStatusQueryPending = false;
	private writeLogPath = (() => {
		const env = process.env.PI_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// 不是已存在的目录 - 原样使用（作为文件路径）
		}
		return env;
	})();

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this._modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// 保存先前状态并启用 raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// 启用 bracketed paste 模式——终端会用 \x1b[200~ ... \x1b[201~ 包裹粘贴内容
		process.stdout.write("\x1b[?2004h");

		// 立即挂载 resize 处理器
		process.stdout.on("resize", this.resizeHandler);

		// 刷新终端尺寸——挂起/恢复后尺寸可能已过期
		// （进程被挂起时 SIGWINCH 会丢失）。仅 Unix，尽力而为。
		refreshTerminalDimensions();

		// 在 Windows 上启用 ENABLE_VIRTUAL_TERMINAL_INPUT，让控制台发送
		// VT 转义序列（例如 Shift+Tab 的 \x1b[Z），而不是丢失修饰键信息的
		// 原始控制台事件。必须在 setRawMode(true) 之后执行，
		// 因为后者会重置控制台模式标志。
		this.enableWindowsVTInput();

		// 查询 Kitty keyboard protocol；当 DA 确认没有 Kitty 响应时回退到 modifyOtherKeys。
		// 参见：https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * 设置 StdinBuffer，把成批到达的输入拆分为一条条独立序列。
	 * 这保证组件收到的是单个事件，让 matchesKey/isKeyRelease 得以正确工作。
	 *
	 * 同时监听 Kitty protocol 的响应，检测到后启用该协议。
	 * 在这里（stdinBuffer 解析之后）而不是在原始 stdin 上做，
	 * 是为了处理响应被拆分到多个事件的情况。
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ escapeTimeout: resolveEscapeTimeoutMs() });

		// 把单条序列转发给输入处理器
		this.stdinBuffer.on("data", (sequence) => {
			if (isProgramStatusReply(sequence)) {
				if (this.programStatusQueryPending) {
					this.programStatusQueryPending = false;
					this.programStatusSupported = true;
					this.writeProgramStatus();
				}
				return;
			}
			const negotiation = this.readKeyboardProtocolNegotiationSequence(sequence);
			if (negotiation === "pending") {
				this.scheduleKeyboardProtocolNegotiationBufferFlush();
				return; // 稍候被拆分的 Kitty 响应的剩余部分。
			}
			if (negotiation && this.handleKeyboardProtocolNegotiationSequence(negotiation.parsed)) {
				return;
			}

			this.forwardInputSequence(negotiation?.sequence ?? sequence);
		});

		// 用 bracketed paste 标记重新包裹粘贴内容，以兼容现有的 editor 处理逻辑
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// 让 stdin 数据先经过缓冲区再转发的处理器
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * 向终端查询 Kitty keyboard protocol 支持情况，可用则启用该协议。
	 *
	 * Kitty 的渐进增强探测要求先请求期望的标志位，再查询它们。末尾的 DA 查询
	 * 是一个哨兵，不认识 Kitty keyboard protocol 的终端也会响应它；若在收到
	 * 若在 Kitty 响应前先收到 DA，就能直接启用 modifyOtherKeys 回退，
	 * 而无需启动超时。
	 *
	 * 请求的 flags 为：
	 * - 1 = disambiguate escape codes（转义码消歧）
	 * - 2 = report event types（按下/重复/释放）
	 * - 4 = report alternate keys（上报 alternate keys：shifted key、base layout key）
	 *
	 * OSC 7501 程序状态查询与 DA 哨兵共用探测：支持它的终端会先于 DA 回复。
	 * `PI_PROGRAM_STATUS=1` 或 `0` 可跳过该查询。
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocolPushed = true;
		this.pendingKeyboardProtocolDeviceAttributes += 1;
		this.clearKeyboardProtocolNegotiationBuffer();
		const programStatusOverride = process.env.PI_PROGRAM_STATUS;
		this.programStatusSupported = programStatusOverride === "1";
		this.programStatusQueryPending = programStatusOverride !== "1" && programStatusOverride !== "0";
		const programStatusQuery = this.programStatusQueryPending ? PROGRAM_STATUS_QUERY : "";
		process.stdout.write(`${KITTY_KEYBOARD_PROTOCOL_QUERY}${programStatusQuery}${DEVICE_ATTRIBUTES_QUERY}`);
		this.writeProgramStatus();
	}

	private handleKeyboardProtocolNegotiationSequence(
		negotiationSequence: KeyboardProtocolNegotiationSequence,
	): boolean {
		this.clearKeyboardProtocolNegotiationBuffer();
		if (negotiationSequence.type === "device-attributes") {
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) return false;
			this.pendingKeyboardProtocolDeviceAttributes -= 1;
			// 最后一个欠下的 DA 回答的是最近一次查询——它此前没有先收到程序状态回复。
			// 更早的 DA 回复属于重启之前的查询。
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) this.programStatusQueryPending = false;
		}
		if (negotiationSequence.type === "kitty-flags") {
			if (negotiationSequence.flags !== 0) {
				this.disableModifyOtherKeys();
				if (!this._kittyProtocolActive) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);
				}
			} else {
				this.enableModifyOtherKeys();
			}
			return true;
		}

		if (!this._kittyProtocolActive) {
			this.enableModifyOtherKeys();
		}
		return true;
	}

	/** 返回解析后的协商回复及其完整（可能已重组）的序列。 */
	private readKeyboardProtocolNegotiationSequence(
		sequence: string,
	): { parsed: KeyboardProtocolNegotiationSequence; sequence: string } | "pending" | undefined {
		if (this.keyboardProtocolNegotiationBuffer) {
			const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			if (negotiationSequence) {
				this.clearKeyboardProtocolNegotiationBuffer();
				return { parsed: negotiationSequence, sequence: bufferedSequence };
			}
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
				return "pending";
			}
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}

		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence) return { parsed: negotiationSequence, sequence };
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			this.setKeyboardProtocolNegotiationBuffer(sequence);
			return "pending";
		}
		return undefined;
	}

	private setKeyboardProtocolNegotiationBuffer(sequence: string): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = sequence;
	}

	private clearKeyboardProtocolNegotiationBuffer(): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = "";
	}

	private flushKeyboardProtocolNegotiationBufferAsInput(): void {
		if (!this.keyboardProtocolNegotiationBuffer) return;
		const sequence = this.keyboardProtocolNegotiationBuffer;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.forwardInputSequence(sequence);
	}

	private scheduleKeyboardProtocolNegotiationBufferFlush(): void {
		if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer) return;
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			this.keyboardProtocolBufferFlushTimer = undefined;
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	private clearKeyboardProtocolNegotiationBufferFlushTimer(): void {
		if (!this.keyboardProtocolBufferFlushTimer) return;
		clearTimeout(this.keyboardProtocolBufferFlushTimer);
		this.keyboardProtocolBufferFlushTimer = undefined;
	}

	private forwardInputSequence(sequence: string): void {
		if (!this.inputHandler) return;
		const shouldDetectNativeShiftEnter =
			sequence === "\r" && (isAppleTerminalSession() || process.platform === "win32");
		const input = normalizeNativeShiftEnterInput(
			sequence,
			shouldDetectNativeShiftEnter,
			shouldDetectNativeShiftEnter && isNativeModifierPressed("shift"),
		);
		this.inputHandler(input);
	}

	private enableModifyOtherKeys(): void {
		if (this._kittyProtocolActive || this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;2m");
		this._modifyOtherKeysActive = true;
	}

	private disableModifyOtherKeys(): void {
		if (!this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;0m");
		this._modifyOtherKeysActive = false;
	}

	/**
	 * 在 Windows 上为 stdin 控制台句柄添加 ENABLE_VIRTUAL_TERMINAL_INPUT（0x0200），
	 * 使终端对组合键发送 VT 序列（例如 Shift+Tab 的 \x1b[Z）。
	 * 若不这样做，libuv 的 ReadConsoleInputW 会丢弃修饰键状态，
	 * Shift+Tab 会以普通制表符（\t）的形式到达。
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			getNativePlatformHelper()?.enableVirtualTerminalInput?.();
		} catch {
			// 原生助手不可用——Shift+Tab 将无法与 Tab 区分。
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (shouldDisableKittyProtocol) {
			// 先禁用 Kitty keyboard protocol，避免迟到的按键释放事件
			// 再生成新的 Kitty 转义序列。
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
		// 已停止时清掉状态，例如退出后或挂起期间。start() 会重新上报。
		if (this.programStatusSupported && this.programStatus) {
			process.stdout.write(formatProgramStatus({ state: "clear" }));
		}
		this.programStatusSupported = false;
		this.programStatusQueryPending = false;

		// 禁用 bracketed paste 模式
		process.stdout.write("\x1b[?2004l");

		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();

		// 若 drainInput() 尚未禁用 Kitty keyboard protocol，则在此禁用
		if (shouldDisableKittyProtocol) {
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		// 清理 StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// 移除事件处理器
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// 暂停 stdin，防止已缓冲的输入（例如 Ctrl+D）在关闭 raw mode 后
		// 被重新解释。这修复了一个竞态条件：SSH 场景下 Ctrl+D
		// 可能因此关闭父 shell。
		process.stdin.pause();

		// 恢复 raw mode 状态
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		process.stdout.write(data);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// 忽略日志写入错误
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// 向下移动
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// 向上移动
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0：不移动
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // 清屏并回到起始位置 (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - 设置终端窗口标题
		process.stdout.write(`\x1b]0;${title}\x07`);
	}

	setProgramStatus(status: ProgramStatus): void {
		this.programStatus = status.state === "clear" ? undefined : status;
		if (this.programStatusSupported) process.stdout.write(formatProgramStatus(status));
	}

	private writeProgramStatus(): void {
		if (this.programStatusSupported && this.programStatus) {
			process.stdout.write(formatProgramStatus(this.programStatus));
		}
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - 不定进度
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - 清除进度
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
