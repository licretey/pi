import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import type { Terminal } from "../src/terminal.ts";

// 从模块中提取 Terminal 类。
const XtermTerminal = xterm.Terminal;

/**
 * 使用 xterm.js 精确模拟终端行为的测试虚拟终端。
 */
export class VirtualTerminal implements Terminal {
	private xterm: XtermTerminalType;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns: number;
	private _rows: number;

	constructor(columns = 80, rows = 24) {
		this._columns = columns;
		this._rows = rows;

		// 按指定尺寸创建 xterm 实例。
		this.xterm = new XtermTerminal({
			cols: columns,
			rows: rows,
			// 关闭所有交互功能，避免影响测试。
			disableStdin: true,
			allowProposedApi: true,
		});
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		// 启用括号粘贴模式，使行为与 ProcessTerminal 一致。
		this.xterm.write("\x1b[?2004h");
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		// 虚拟终端没有标准输入需要清空，因此不执行任何操作。
	}

	stop(): void {
		// 关闭括号粘贴模式。
		this.xterm.write("\x1b[?2004l");
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		this.xterm.write(data);
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get kittyProtocolActive(): boolean {
		// 测试中虚拟终端始终报告 Kitty 协议已启用。
		return true;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// 向下移动。
			this.xterm.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// 向上移动。
			this.xterm.write(`\x1b[${-lines}A`);
		}
		// lines === 0：不移动。
	}

	hideCursor(): void {
		this.xterm.write("\x1b[?25l");
	}

	showCursor(): void {
		this.xterm.write("\x1b[?25h");
	}

	clearLine(): void {
		this.xterm.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.xterm.write("\x1b[J");
	}

	clearScreen(): void {
		this.xterm.write("\x1b[2J\x1b[H"); // 清屏并将光标移至左上角（1,1）。
	}

	setTitle(title: string): void {
		// 使用 OSC 0;title BEL 设置终端窗口标题。
		this.xterm.write(`\x1b]0;${title}\x07`);
	}

	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}

	// Terminal 接口中没有的测试专用方法。

	/**
	 * 模拟键盘输入。
	 */
	sendInput(data: string): void {
		if (this.inputHandler) {
			this.inputHandler(data);
		}
	}

	/**
	 * 调整终端尺寸。
	 */
	resize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		this.xterm.resize(columns, rows);
		if (this.resizeHandler) {
			this.resizeHandler();
		}
	}

	/**
	 * 等待所有待处理写入完成。视口和滚动缓冲区也会随之更新。
	 */
	async flush(): Promise<void> {
		// 写入空字符串，确保此前的写入全部刷新。
		return new Promise<void>((resolve) => {
			this.xterm.write("", () => resolve());
		});
	}

	/**
	 * 刷新并获取视口，供测试便捷调用。
	 */
	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	/**
	 * 获取可见视口（当前屏幕上显示的内容）。
	 * 注意：写入数据后进行测试时，应使用 getViewportAfterWrite()。
	 */
	getViewport(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		// 仅获取可见行（视口内容）。
		for (let i = 0; i < this.xterm.rows; i++) {
			const line = buffer.getLine(buffer.viewportY + i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * 获取完整的滚动缓冲区。
	 */
	getScrollBuffer(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		// 获取缓冲区中的所有行，包括回滚区域。
		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * 清除终端视口。
	 */
	clear(): void {
		this.xterm.clear();
	}

	/**
	 * 完全重置终端。
	 */
	reset(): void {
		this.xterm.reset();
	}

	/**
	 * 获取光标位置。
	 */
	getCursorPosition(): { x: number; y: number } {
		const buffer = this.xterm.buffer.active;
		return {
			x: buffer.cursorX,
			y: buffer.cursorY,
		};
	}

	/** 等待 TUI 的节流渲染流程完成。 */
	async waitForRender(): Promise<void> {
		await new Promise<void>((resolve) => process.nextTick(resolve));
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		await this.flush();
	}
}
