/** 每次鼠标滚轮事件移动的行数；设为 `"auto"` 时会加速快速滚动。 */
export type WheelScrollLines = number | "auto";

// 间隔小于此值的多个事件属于同一个物理滚轮刻度（Ghostty 发出的事件间隔约为 4 毫秒），
// 或来自高分辨率滚轮；每个事件只移动一行，不进行加速。
const BURST_GAP_MS = 5;
// 暂停时间超过此值时，视为本次滚动手势结束。
const GESTURE_GAP_MS = 200;
// 每个事件移动一行所对应的平均事件间隔；事件越快，移动行数按比例增加。
const REFERENCE_GAP_MS = 100;
const MAX_AUTO_LINES = 6;

/**
 * macOS 本地终端收到的滚轮和触控板增量已由操作系统加速，因此每行会产生一个事件。
 * 其他平台以及无法确定客户端平台的 SSH 会话，通常每个滚轮刻度只发送一个事件。
 */
function terminalAcceleratesWheel(): boolean {
	const env = process.env;
	return (
		process.platform === "darwin" &&
		env.SSH_CONNECTION === undefined &&
		env.SSH_CLIENT === undefined &&
		env.SSH_TTY === undefined
	);
}

/**
 * 将滚轮事件转换为移动行数。
 *
 * 在不会加速滚轮输入的终端中使用 `"auto"` 模式时，移动行数取决于事件速度：单独一次刻度移动一行，
 * 快速滚动时每个事件最多移动六行。例如，刻度间隔为 100 毫秒时每次移动一行，间隔为 50 毫秒时移动两行，
 * 间隔为 20 毫秒时移动五行。
 */
export class WheelScrollAccelerator {
	private lines: WheelScrollLines;
	private readonly accelerate: boolean;
	private lastTime = Number.NEGATIVE_INFINITY;
	private lastDirection = 0;
	private averageGap: number | undefined;
	private carry = 0;

	constructor(lines: WheelScrollLines = "auto", accelerate = !terminalAcceleratesWheel()) {
		this.lines = lines;
		this.accelerate = accelerate;
	}

	setLines(lines: WheelScrollLines): void {
		this.lines = lines;
		this.reset();
	}

	/** 返回 `now`（毫秒）时 `direction` 方向的滚轮事件对应的正数行数。 */
	next(direction: -1 | 1, now: number): number {
		if (this.lines !== "auto") return Number.isFinite(this.lines) ? Math.max(1, Math.floor(this.lines)) : 1;
		if (!this.accelerate) return 1;

		const gap = now - this.lastTime;
		const sameGesture = direction === this.lastDirection && gap <= GESTURE_GAP_MS;
		this.lastTime = now;
		this.lastDirection = direction;
		if (!sameGesture) {
			this.averageGap = undefined;
			this.carry = 0;
			return 1;
		}
		if (gap < BURST_GAP_MS) return 1;

		this.averageGap = this.averageGap === undefined ? gap : (this.averageGap + gap) / 2;
		const lines = Math.min(MAX_AUTO_LINES, Math.max(1, REFERENCE_GAP_MS / this.averageGap)) + this.carry;
		const whole = Math.floor(lines);
		this.carry = lines - whole;
		return whole;
	}

	private reset(): void {
		this.lastTime = Number.NEGATIVE_INFINITY;
		this.lastDirection = 0;
		this.averageGap = undefined;
		this.carry = 0;
	}
}
