/**
 * 采用差量渲染的最小 TUI 实现
 */

import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import {
	parseOscColorResponse,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
	type TerminalColors,
} from "./terminal-colors.ts";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

/**
 * Component 接口——所有组件都必须实现此接口。
 */
export type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
export type TuiMouseButton = "left" | "middle" | "right" | "none";

/** 以单元格为基准归一化后的鼠标事件。坐标从 0 开始。 */
export interface TuiMouseEvent {
	type: TuiMouseEventType;
	button: TuiMouseButton;
	/** 相对于接收组件的坐标。 */
	x: number;
	y: number;
	/** 终端的绝对坐标。 */
	screenX: number;
	screenY: number;
	/** 当前组件的边界尺寸。 */
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** 逻辑行。负值表示向上滚动。 */
	wheelDelta?: number;
	/** type 为 click 时表示连续点击次数。 */
	clickCount?: number;
}

export interface TuiMouseEventResult {
	/** 停止传播，并抑制 renderer 层的回退行为。 */
	handled?: boolean;
	/** 把后续的 drag/release 事件路由到本组件。隐含 handled。 */
	capture?: boolean;
	/** 把键盘焦点交给本组件。隐含 handled。 */
	focus?: boolean;
	/**
	 * 显式请求或抑制一次渲染。move 与 release 默认为 false；
	 * press、click、drag、wheel 默认为 true。
	 */
	render?: boolean;
}

/** 容器与 alternate-screen 分发使用的内部目标元数据。 */
export interface TuiMouseDispatchTarget {
	component: Component;
	originX: number;
	originY: number;
	width: number;
	height: number;
}

/** 向具体组件分发事件的结果。 */
export interface TuiMouseDispatchResult extends TuiMouseEventResult {
	handled: true;
	target: TuiMouseDispatchTarget;
	/** 键盘焦点目标，可能是委托处理的父容器。 */
	focusTarget?: Component;
}

/**
 * 向组件分发事件，并保留确切的目标与坐标变换信息。
 * 容器在把事件转发给嵌套子组件时使用它。
 */
export function dispatchMouseEvent(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
	const result = component.handleMouse?.(event);
	if (!result) return undefined;
	if ("target" in result) {
		// 组件把事件转发给它所承载的子组件。与委托型容器一样，它自己把按键
		// 路由给该子组件，因此键盘焦点仍留在它身上。若直接把焦点交给子组件，
		// 一旦宿主把子组件移除（例如关闭的设置子菜单），焦点就会落在
		// 已脱离的组件上。
		const forwarded = result as TuiMouseDispatchResult;
		return forwarded.focus && component.handleInput ? { ...forwarded, focusTarget: component } : forwarded;
	}
	if (!result.handled && !result.capture && !result.focus) return undefined;
	return {
		...result,
		handled: true,
		...(result.focus ? { focusTarget: component } : {}),
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

/** 为先前分发过的鼠标目标重建本地坐标。 */
export function retargetMouseEvent(event: TuiMouseEvent, target: TuiMouseDispatchTarget): TuiMouseEvent {
	return {
		...event,
		x: event.screenX - target.originX,
		y: event.screenY - target.originY,
		width: target.width,
		height: target.height,
	};
}

export interface Component {
	/**
	 * 为给定视口宽度把组件渲染成多行
	 * @param width - 当前视口宽度
	 * @returns 每个字符串代表一行的数组
	 */
	render(width: number): string[];

	/** 组件获得焦点时处理键盘输入的可选处理器。 */
	handleInput?(data: string): void;

	/** 归一化鼠标事件的可选处理器。 */
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;

	/**
	 * 为 true 时，组件接收按键释放事件（Kitty protocol）。
	 * 默认为 false——释放事件会被过滤掉。
	 */
	wantsKeyRelease?: boolean;

	/**
	 * 使任何已缓存的渲染状态失效。
	 * 在主题变化或组件需要从头重新渲染时调用。
	 */
	invalidate(): void;
}

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;
type PendingTerminalColorQuery = {
	foreground?: RgbColor;
	background?: RgbColor;
	palette: Array<RgbColor | undefined>;
	/** 已经回复过的目标，因此重复回复不会重复计数。 */
	replied: Set<string>;
	/**
	 * 接收结果：超时前是 promise 的 resolve，之后是 `onLateReply`。
	 * 查询完成后（收到 DA1 回复，或所有颜色都已回复）即清除；更晚的回复会被忽略。
	 */
	deliver: ((colors: TerminalColors) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

const TERMINAL_PALETTE_SIZE = 16;
/** OSC 10、11，加 OSC 4 查询每个调色板颜色。 */
const TERMINAL_COLOR_REPLY_COUNT = 2 + TERMINAL_PALETTE_SIZE;
/**
 * 默认颜色、调色板色 0-15，以及末尾的主设备属性（DA1）请求。
 * 每个终端都会回答 DA1，且按顺序回复，因此 DA1 回复标记着颜色回复的结束，
 * 对忽略颜色查询的终端同样如此。
 */
const TERMINAL_COLOR_QUERY = `\x1b]10;?\x07\x1b]11;?\x07${Array.from(
	{ length: TERMINAL_PALETTE_SIZE },
	(_, index) => `\x1b]4;${index};?\x07`,
).join("")}\x1b[c`;
const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = /^\x1b\[\?[\d;]*c$/;

/**
 * 可以接收焦点并显示硬件光标的组件接口。
 * 获得焦点时，组件应在 render 输出的光标位置发出 CURSOR_MARKER。
 * TUI 会找到该标记并在那里定位硬件光标，
 * 从而正确放置 IME 候选窗口。
 */
export interface Focusable {
	/** 由 TUI 在焦点变化时设置。为 true 时组件应发出 CURSOR_MARKER。 */
	focused: boolean;
}

/** 用于检查组件是否实现 Focusable 的类型守卫 */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * 光标位置标记——APC（Application Program Command）序列。
 * 这是一个零宽转义序列，终端会忽略它。
 * 组件获得焦点时在光标位置发出它。
 * TUI 找到并剥离该标记，然后把硬件光标定位到那里。
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

/** 假光标标记——围绕被绘制为光标的文本的零宽 APC 序列。参见 resolveFakeCursors()。 */
export const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
export const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";
// CURSOR_MARKER + FAKE_CURSOR_START + 文本 + FAKE_CURSOR_END。若恰好在光标单元格之后截断行，END 标记会被丢弃。
const FOCUSED_FAKE_CURSOR = /(\x1b_pi:c\x07)\x1b_pi:fc\x07(.*?)(?:\x1b_pi:\/fc\x07|$)/s;

/** 用假光标标记包裹文本。 */
export function renderFakeCursor(text: string): string {
	return `${FAKE_CURSOR_START}${text}${FAKE_CURSOR_END}`;
}

export { visibleWidth };

/**
 * overlay 的锚点位置
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * overlay 的边距配置
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** 可以为绝对值（数字）或百分比（如 "50%" 的字符串） */
export type SizeValue = number | `${number}%`;

/** 给定参照尺寸，把 SizeValue 解析为绝对值 */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// 解析百分比字符串，如 "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * overlay 定位与尺寸的选项。
 * 取值可以是绝对数字或百分比字符串（例如 "50%"）。
 */
export interface OverlayOptions {
	// === 尺寸 ===
	/** 宽度（列数），或终端宽度的百分比（例如 "50%"） */
	width?: SizeValue;
	/** 最小宽度（列数） */
	minWidth?: number;
	/** 最大高度（行数），或终端高度的百分比（例如 "50%"） */
	maxHeight?: SizeValue;

	// === 定位——基于锚点 ===
	/** 定位用的锚点（默认 'center'） */
	anchor?: OverlayAnchor;
	/** 相对锚点的水平偏移（正数 = 向右） */
	offsetX?: number;
	/** 相对锚点的垂直偏移（正数 = 向下） */
	offsetY?: number;

	// === 定位——百分比或绝对值 ===
	/** 行位置：绝对数字，或百分比（例如 "25%" = 距顶部 25%） */
	row?: SizeValue;
	/** 列位置：绝对数字，或百分比（例如 "50%" = 水平居中） */
	col?: SizeValue;

	// === 距终端边缘的边距 ===
	/** 距终端边缘的边距。数字作用于所有边。 */
	margin?: OverlayMargin | number;

	// === 可见性 ===
	/**
	 * 基于终端尺寸控制 overlay 的可见性。
	 * 提供时，只有该函数返回 true 才渲染 overlay。
	 * 每个渲染周期都会以当前终端尺寸调用一次。
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** 为 true 时，显示时不捕获键盘焦点 */
	nonCapturing?: boolean;
}

/** {@link OverlayHandle.unfocus} 的选项。 */
export interface OverlayUnfocusOptions {
	/** 释放本 overlay 后要聚焦的显式目标。 */
	target: Component | null;
}

/** 最近一次渲染的、相对终端的 overlay 矩形。 */
export interface OverlayBounds {
	row: number;
	col: number;
	width: number;
	height: number;
}

/**
 * showOverlay 返回的句柄，用于控制 overlay
 */
export interface OverlayHandle {
	/** 永久移除 overlay（无法再次显示） */
	hide(): void;
	/** 临时隐藏或显示 overlay */
	setHidden(hidden: boolean): void;
	/** 检查 overlay 是否被临时隐藏 */
	isHidden(): boolean;
	/** 聚焦本 overlay，并把它带到可视最前面 */
	focus(): void;
	/** 把焦点交还给下一个可见的捕获型 overlay、先前的目标，或在提供时交给显式目标 */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** 检查本 overlay 当前是否拥有焦点 */
	isFocused(): boolean;
	/** 获取可见 overlay 最近一次渲染的边界。 */
	getBounds(): OverlayBounds | undefined;
}

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
	bounds?: OverlayBounds;
};

type RenderedOverlayLayout = {
	entry: OverlayStackEntry;
	row: number;
	col: number;
	width: number;
	height: number;
};

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * 容器组件——用于包含其他组件。
 */
export class Container implements Component {
	children: Component[] = [];
	private mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const mouseChildren =
			this.mouseLayout?.width === event.width
				? this.mouseLayout.children
				: this.children.map((component) => ({ component, height: component.render(event.width).length }));
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (event.y >= childY && event.y < childY + childHeight) {
				const result = dispatchMouseEvent(child, {
					...event,
					y: event.y - childY,
					height: childHeight,
				});
				if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
				return result;
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			mouseChildren.push({ component: child, height: childLines.length });
			for (const line of childLines) {
				lines.push(line);
			}
		}
		this.mouseLayout = { width, children: mouseChildren };
		return lines;
	}
}

/**
 * TUI——以差量渲染管理终端 UI 的主类
 */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** 在固定列处把 overlay 内容合成到终端行上。 */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
	/** 把 renderer 的输出留在原地，供接管同一终端的另一个 TUI 使用。 */
	preserveScreen?: boolean;
}

export interface TUI extends Component {
	readonly mode: TuiMode;
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	readonly fullRedraws: number;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(options?: TuiStopOptions): void;
	renderNow(force?: boolean): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	queryTerminalColors(options: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors>;
}

export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

export abstract class TuiBase extends Container implements TUI {
	abstract readonly mode: TuiMode;
	public terminal: Terminal;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<TuiInputListener>();

	/** 调试键（Shift+Ctrl+D）的全局回调。在输入转发给聚焦组件之前调用。 */
	public onDebug?: () => void;
	private renderRequested = false;
	private immediateRenderScheduled = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private showHardwareCursor = false;
	private clearOnShrink = false;
	protected fullRedrawCount = 0;
	protected stopped = false;
	/**
	 * 等待各自 DA1 回复的颜色查询，最旧的在前。终端按顺序回复，因此
	 * 颜色回复总是属于最旧的查询。查询超时后仍留在这里以收集迟到的回复。
	 */
	private pendingTerminalColorQueries: PendingTerminalColorQuery[] = [];
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	private terminalColorSchemeNotificationsEnabled = false;
	/** 调试/崩溃日志的目录。未定义时禁用调试日志，崩溃转储退回到 OS 临时目录。 */
	protected readonly logDirectory: string | undefined;

	// 为渲染在基础内容之上的模态组件维护的 overlay 栈
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];
	private renderedOverlayLayouts: RenderedOverlayLayout[] = [];

	get hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super();
		this.terminal = terminal;
		this.logDirectory = logDirectory;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	protected abstract doRender(): void;

	protected resetRenderState(): void {}

	protected beforeTerminalStart(): void {}

	protected afterTerminalStart(): void {}

	protected beforeTerminalStop(_options: TuiStopOptions): void {}

	protected afterTerminalStop(_options: TuiStopOptions): void {}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.hideTerminalCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * 设置内容变窄时是否触发完整重绘。
	 * 为 true 时，内容缩小时会清空空行。
	 * 为 false（默认）时空行保留（在较慢的终端上减少重绘）。
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	getFocusedComponent(): Component | null {
		return this.focusedComponent;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					this.overlayFocusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				this.overlayFocusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	private isComponentMounted(component: Component): boolean {
		return this.getMountedRoots().some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * 以可配置的定位与尺寸显示一个 overlay 组件。
	 * 返回控制该 overlay 可见性的句柄。
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// 只有 overlay 确实可见时才聚焦它
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.hideTerminalCursor();
		this.requestRender();

		// 返回控制该 overlay 的句柄
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// 若该 overlay 拥有焦点则恢复焦点
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.hideTerminalCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// 隐藏/显示时更新焦点
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// 若该 overlay 拥有焦点，把焦点移到下一个可见的 overlay 或 preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// 显示时恢复焦点到该 overlay（若它确实可见）
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
			getBounds: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry) || !entry.bounds) return undefined;
				return { ...entry.bounds };
			},
		};
	}

	/** 隐藏最上层 overlay 并恢复先前焦点。 */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		if (this.focusedComponent === overlay.component) {
			// 找到最上层的可见 overlay，否则回退到 preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.hideTerminalCursor();
		this.requestRender();
	}

	/** 运行期间隐藏光标。stop() 之后 shell 接管光标，必须保持可见。 */
	private hideTerminalCursor(): void {
		if (!this.stopped) this.terminal.hideCursor();
	}

	/** 检查是否存在任何可见的 overlay */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** 检查聚焦的组件是否为可见的 overlay */
	protected isOverlayFocused(): boolean {
		return this.overlayStack.some(
			(entry) => entry.component === this.focusedComponent && this.isOverlayVisible(entry),
		);
	}

	/** 点击嵌套控件时，把 overlay 容器保持为键盘焦点所有者。 */
	protected resolveMouseFocusTarget(component: Component): Component {
		for (let index = this.overlayStack.length - 1; index >= 0; index--) {
			const overlay = this.overlayStack[index]!;
			if (this.isOverlayVisible(overlay) && this.containsComponent(overlay.component, component)) {
				return overlay.component;
			}
		}
		return component;
	}

	/** 把事件分发给指针所在的可视最上层 overlay。 */
	protected dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		for (let index = this.renderedOverlayLayouts.length - 1; index >= 0; index--) {
			const layout = this.renderedOverlayLayouts[index]!;
			if (
				event.screenX < layout.col ||
				event.screenX >= layout.col + layout.width ||
				event.screenY < layout.row ||
				event.screenY >= layout.row + layout.height
			) {
				continue;
			}
			const result = dispatchMouseEvent(layout.entry.component, {
				...event,
				x: event.screenX - layout.col,
				y: event.screenY - layout.row,
				width: layout.width,
				height: layout.height,
			});
			return result
				? {
						hit: true,
						result: result.focus ? { ...result, focusTarget: layout.entry.component } : result,
					}
				: { hit: true };
		}
		return { hit: false };
	}

	/** 检查某个 overlay 条目当前是否可见 */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** 找到可视最前面的可见捕获型 overlay（若有） */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	override invalidate(): void {
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate();
	}

	start(): void {
		this.stopped = false;
		this.beforeTerminalStart();
		this.terminal.start(
			(data) => this.handleTerminalInput(data),
			() => this.requestRender(),
		);
		this.afterTerminalStart();
		this.terminal.hideCursor();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: TuiInputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.delete(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	private queryCellSize(): void {
		// 仅在终端支持图片时才查询（cell size 只用于图片渲染）
		if (!getCapabilities().images) {
			return;
		}
		// 向终端查询以像素为单位的 cell size：CSI 16 t
		// 响应格式：CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(options: TuiStopOptions = {}): void {
		this.stopped = true;
		this.cancelRenderTimer();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031l");
		}
		this.beforeTerminalStop(options);
		this.terminal.showCursor();
		this.terminal.stop();
		this.afterTerminalStop(options);
	}

	renderNow(force = false): void {
		if (force) this.resetRenderState();
		this.renderRequested = false;
		this.cancelRenderTimer();
		this.lastRenderAt = performance.now();
		this.doRender();
	}

	requestRender(force = false): void {
		if (force) {
			this.resetRenderState();
			this.requestImmediateRender();
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private requestImmediateRender(): void {
		this.cancelRenderTimer();
		this.renderRequested = true;
		if (this.immediateRenderScheduled) return;
		this.immediateRenderScheduled = true;
		process.nextTick(() => {
			this.immediateRenderScheduled = false;
			if (this.stopped || !this.renderRequested) return;
			// 先前排队的 scheduleRender() 可能在本回调运行前
			// 创建了定时器。用户输入必须抢占那个被节流的帧。
			this.cancelRenderTimer();
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
		});
	}

	private cancelRenderTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleTerminalInput(data: string): void {
		if (this.consumeTerminalColorResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// 消费终端的 cell size 响应，不阻塞其他无关输入。
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// 全局调试键处理器（Shift+Ctrl+D）
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// 若聚焦组件是 overlay，验证它仍然可见
		// （可见性可能因终端 resize 或 visible() 回调而改变）
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// 聚焦的 overlay 已不可见，重定向到最上层的可见 overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// 把输入传给聚焦的组件（包括 Ctrl+C）
		// 聚焦组件可以自行决定如何处理 Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// 过滤掉按键释放事件，除非组件选择接收
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			// 键盘输入对延迟敏感。避免走被节流的定时器路径——
			// 在 Windows 上即使 setTimeout(0) 也可能消耗整整 16 ms 的一个 tick。
			this.requestImmediateRender();
		}
	}

	private consumeTerminalColorResponse(data: string): boolean {
		const query = this.pendingTerminalColorQueries[0];
		if (!query) {
			return false;
		}
		if (DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(data)) {
			this.pendingTerminalColorQueries.shift();
			this.completeTerminalColorQuery(query);
			return true;
		}

		const response = parseOscColorResponse(data);
		if (!response) {
			return false;
		}
		const { target, rgb } = response;
		const key = String(target);
		if (!query.deliver || query.replied.has(key)) {
			return true;
		}
		query.replied.add(key);
		if (target === "foreground") {
			query.foreground = rgb;
		} else if (target === "background") {
			query.background = rgb;
		} else if (target < TERMINAL_PALETTE_SIZE) {
			query.palette[target] = rgb;
		}
		if (query.replied.size === TERMINAL_COLOR_REPLY_COUNT) {
			this.completeTerminalColorQuery(query);
		}
		return true;
	}

	private terminalColorQueryResult(query: PendingTerminalColorQuery): TerminalColors {
		const palette = query.palette.every((color) => color !== undefined) ? (query.palette as RgbColor[]) : undefined;
		return { foreground: query.foreground, background: query.background, palette };
	}

	private completeTerminalColorQuery(query: PendingTerminalColorQuery): void {
		const deliver = query.deliver;
		query.deliver = undefined;
		clearTimeout(query.timer);
		deliver?.(this.terminalColorQueryResult(query));
	}

	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	private consumeCellSizeResponse(data: string): boolean {
		// 响应格式：ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// 使所有组件失效，让图片以正确尺寸重新渲染。
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * 从 options 解析 overlay 布局。
	 * 返回供渲染使用的 { width, row, col, maxHeight }。
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// 解析 margin（收敛到非负值）
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// 扣除边距后的可用空间
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === 解析宽度 ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// 应用 minWidth
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// 收敛到可用空间内
		width = Math.max(1, Math.min(width, availWidth));

		// === 解析 maxHeight ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// 收敛到可用空间内
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// overlay 的有效高度（可能被 maxHeight 收敛）
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === 解析位置 ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// 百分比：0% = 顶部，100% = 底部（overlay 保持在边界内）
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// 格式非法，回退到居中
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// 绝对行位置
				row = opt.row;
			}
		} else {
			// 基于锚点（默认：center）
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// 百分比：0% = 左侧，100% = 右侧（overlay 保持在边界内）
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// 格式非法，回退到居中
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// 绝对列位置
				col = opt.col;
			}
		} else {
			// 基于锚点（默认：center）
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// 应用偏移
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// 收敛到终端边界之内（遵守边距）
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** 按聚焦顺序（值越大越靠上层）把所有 overlay 合成到内容行上。 */
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) {
			this.renderedOverlayLayouts = [];
			return lines;
		}
		const result = [...lines];

		for (const entry of this.overlayStack) entry.bounds = undefined;

		// 预渲染所有可见的 overlay 并计算位置
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// 先以 height=0 获取布局，从而确定 width 和 maxHeight
			// （它们不依赖 overlay 的高度）
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// 按计算出的宽度渲染组件
			let overlayLines = this.resolveFakeCursors(component.render(width));

			// 若指定了 maxHeight 则应用之
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// 用实际的 overlay 高度获取最终的 row/col
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			entry.bounds = { row, col, width, height: overlayLines.length };

			rendered.push({ entry, overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}
		this.renderedOverlayLayouts = rendered.map(({ entry, row, col, w, overlayLines }) => ({
			entry,
			row,
			col,
			width: w,
			height: overlayLines.length,
		}));

		// 补齐到至少终端高度，使 overlay 获得相对屏幕的位置。
		// 不纳入 maxLinesRendered：这个历史高水位线曾造成自我强化的
		// 膨胀，在终端变宽时把内容顶进 scrollback。
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// 若内容比 overlay 放置或工作区所需更短，用空行扩展 result
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// 合成每个 overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// 防御措施：合成前把 overlay 行截断到声明的宽度
					// （组件本应遵守宽度，这里保证这一点）
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	protected applyLineResets(lines: string[]): string[] {
		const reset = SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}

	/**
	 * 从渲染的行中查找并提取光标位置。
	 * 搜索 CURSOR_MARKER，计算其位置，并从输出中剥离该标记。
	 * 只扫描底部终端高度以内的行（可见视口）。
	 * @param lines - 待搜索的渲染行
	 * @param height - 终端高度（可见视口大小）
	 * @returns 光标位置 { row, col }；未找到标记则为 null
	 */
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// 只扫描底部 `height` 行（可见视口）
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// 计算可视列（标记之前文本的宽度）
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// 从行中剥离标记
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	/**
	 * 把假光标标记解析为反显（reverse video）。显示硬件光标时，
	 * 紧跟 CURSOR_MARKER 之后的假光标会被丢弃，因为终端光标画在那里。
	 * 未聚焦组件的假光标没有 CURSOR_MARKER，保持可见。
	 */
	protected resolveFakeCursors(lines: string[]): string[] {
		return lines.map((line) => {
			if (!line.includes(FAKE_CURSOR_START)) return line;
			const resolved = this.showHardwareCursor ? line.replace(FOCUSED_FAKE_CURSOR, "$1$2") : line;
			return resolved.replaceAll(FAKE_CURSOR_START, "\x1b[7m").replaceAll(FAKE_CURSOR_END, "\x1b[27m");
		});
	}

	/**
	 * 查询终端的主题颜色：默认 foreground（OSC 10）、默认 background
	 * （OSC 11）和 ANSI 色 0-15（OSC 4），随后是标记回复结束的 DA1 请求。
	 * 当 DA1 回复或全部颜色回复到达时解析，或超时后解析。
	 * 终端未上报的颜色为 undefined；只有 16 个全部到达时才设置 palette。
	 * @param timeoutMs 查询超时（毫秒），用于对 DA1 也不响应的终端。
	 * @param onLateReply 若查询在超时后才完成（例如慢速链路），由它接收回复。
	 */
	queryTerminalColors({
		timeoutMs,
		onLateReply,
	}: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors> {
		return new Promise((resolve) => {
			const query: PendingTerminalColorQuery = {
				palette: Array.from({ length: TERMINAL_PALETTE_SIZE }, () => undefined),
				replied: new Set(),
				deliver: resolve,
				timer: undefined,
			};
			// 用目前已有的回复先行解析，并继续为 `onLateReply` 收集迟到的回复。
			query.timer = setTimeout(() => {
				query.deliver = onLateReply;
				resolve(this.terminalColorQueryResult(query));
			}, timeoutMs);
			this.pendingTerminalColorQueries.push(query);
			this.terminal.write(TERMINAL_COLOR_QUERY);
		});
	}
}
