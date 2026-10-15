import type { AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.ts";
import { getKeybindings } from "../keybindings.ts";
import { decodePrintableKey, matchesKey } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	renderFakeCursor,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import {
	autocompleteBoundaryRegex,
	autocompleteSeparatorRegex,
	cjkBreakRegex,
	getGraphemeSegmenter,
	getWordSegmenter,
	isWhitespaceChar,
	sliceByColumn,
	visibleWidth,
} from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.ts";

const graphemeSegmenter = getGraphemeSegmenter();
const wordSegmenter = getWordSegmenter();

/** 匹配粘贴标记的正则，如 `[paste #1 +123 lines]` 或 `[paste #2 1234 chars]`。 */
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** 用于单段测试的非全局版本。 */
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

/** 检查某个 segment 是否为粘贴标记（即由 segmentWithMarkers 合并而成）。 */
function isPasteMarker(segment: string): boolean {
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

/**
 * 包装 Intl.Segmenter 的分段器，把落在粘贴标记内的 grapheme 合并为
 * 单个原子 segment。这使光标移动、删除、word wrap 等操作把粘贴标记
 * 当作单一单元处理。
 *
 * 只有其数字 ID 存在于 `validIds` 中的标记才会被合并。
 */
function segmentWithMarkers(
	text: string,
	baseSegmenter: Intl.Segmenter,
	validIds: Set<number>,
): Iterable<Intl.SegmentData> {
	// 快速路径：文本中没有粘贴标记，或没有合法 ID。
	if (validIds.size === 0 || !text.includes("[paste #")) {
		return baseSegmenter.segment(text);
	}

	// 找出所有 ID 合法的标记区间。
	const markers: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
		const id = Number.parseInt(m[1]!, 10);
		if (!validIds.has(id)) continue;
		markers.push({ start: m.index, end: m.index + m[0].length });
	}
	if (markers.length === 0) {
		return baseSegmenter.segment(text);
	}

	// 构建合并后的 segment 列表。
	const baseSegments = baseSegmenter.segment(text);
	const result: Intl.SegmentData[] = [];
	let markerIdx = 0;

	for (const seg of baseSegments) {
		// 跳过完全位于该 segment 之前的标记。
		while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
			markerIdx++;
		}

		const marker = markerIdx < markers.length ? markers[markerIdx]! : null;

		if (marker && seg.index >= marker.start && seg.index < marker.end) {
			// 该 segment 落在某个标记内部。
			// 若它是标记的第一个 segment，则发出一个合并后的 segment。
			if (seg.index === marker.start) {
				const markerText = text.slice(marker.start, marker.end);
				result.push({
					segment: markerText,
					index: marker.start,
					input: text,
				});
			}
			// 否则跳过（已合并进第一个 segment）。
		} else {
			result.push(seg);
		}
	}

	return result;
}

/**
 * 表示 word wrap 布局中的一段文本。
 * 同时跟踪文本内容及其在原始行中的位置。
 */
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

/**
 * 把一行文本切分为 word wrap 后的 chunk。
 * 尽可能在单词边界处折行；对超出现可用宽度的长单词，
 * 回退到字符级折行。
 *
 * @param line - 待换行的文本行
 * @param maxWidth - 每个 chunk 的最大可见宽度
 * @param preSegmented - 可选的预分词 grapheme（例如带粘贴标记感知）。
 *                       省略时使用默认的 Intl.Segmenter。
 * @returns 包含文本与位置信息的 chunk 数组
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = preSegmented ?? [...graphemeSegmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	// 折行机会：最后一个空白与非空白 grapheme 之间的位置，
	// 即允许换行的位置。
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

		// 前进前的溢出检查。
		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				// 回退到上一个折行机会（剩余内容加上当前 grapheme
				// 仍能容纳在 maxWidth 之内）。
				chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex });
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				// 没有可用的折行机会：在当前位置强制折断。
				// 这也覆盖了回退到单词边界无济于事的情况——剩余内容
				// 加上当前 grapheme（例如一个宽字符）仍超出 maxWidth。
				chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex });
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			// 单个原子 segment 宽于 maxWidth（例如窄终端中的
			// 粘贴标记）。按 grapheme 粒度重新换行。

			// 对光标移动/编辑而言，该 segment 在逻辑上仍是原子的——
			// 这次拆分只是 word wrap 布局层面的视觉呈现。
			const subChunks = wordWrapLine(grapheme, maxWidth);
			for (let j = 0; j < subChunks.length - 1; j++) {
				const sc = subChunks[j]!;
				chunks.push({ text: sc.text, startIndex: charIndex + sc.startIndex, endIndex: charIndex + sc.endIndex });
			}
			const last = subChunks[subChunks.length - 1]!;
			chunkStart = charIndex + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOppIndex = -1;
			continue;
		}

		// 前进。
		currentWidth += gWidth;

		// 记录折行机会：空白后跟非空白
		// （多个空格合并；折行点在最后一个空格之后），
		// 或两侧任一侧为 CJK 的边界（CJK 允许在任意相邻字符之间折行）。
		const next = segments[i + 1];
		if (isWs && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		} else if (!isWs && next && !isWhitespaceChar(next.segment)) {
			const isCjk = !isPasteMarker(grapheme) && cjkBreakRegex.test(grapheme);
			const nextIsCjk = !isPasteMarker(next.segment) && cjkBreakRegex.test(next.segment);
			if (isCjk || nextIsCjk) {
				wrapOppIndex = next.index;
				wrapOppWidth = currentWidth;
			}
		}
	}

	// 压入最后一个 chunk。
	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });

	return chunks;
}

// 可打印键的 Kitty CSI-u 序列，包含可选的 shifted/base codepoint。
interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

/** 撤销快照：editor 文本状态加粘贴注册表。 */
interface EditorSnapshot {
	state: EditorState;
	pastes: Map<number, string>;
	pasteCounter: number;
}

interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}

export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
}

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;
const DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"];
// 未加引号的补全以空白或 CJK 标点结束；加引号的路径两者都可包含。
const unquotedAutocompleteSuffixRegex = new RegExp(`(?:(?!${autocompleteSeparatorRegex.source}).)*`, "u");
// 触发 token 可能被包在正文中，例如 "(@src/foo" 或 "`@src/foo"。
const autocompleteTokenStartSource = `${autocompleteBoundaryRegex.source}[([{<\`]*`;

function escapeCharacterClass(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

function buildTriggerPattern(triggerCharacters: string[]): RegExp {
	return new RegExp(
		`${autocompleteTokenStartSource}(?:@"[^"]*|[${triggerCharacters.map(escapeCharacterClass).join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
}

function buildDebouncePattern(triggerCharacters: string[]): RegExp {
	const escapedWithoutAt = triggerCharacters.filter((character) => character !== "@").map(escapeCharacterClass);
	return new RegExp(
		`${autocompleteTokenStartSource}(?:@(?:"[^"]*|${unquotedAutocompleteSuffixRegex.source})|[${escapedWithoutAt.join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
}

function createScrollBorder(direction: "↑" | "↓", hiddenLineCount: number, width: number): string {
	const availableWidth = Math.max(0, width);
	const label = ` ${direction} ${hiddenLineCount} more `;
	const labelWidth = visibleWidth(label);
	if (labelWidth + 2 <= availableWidth) {
		const leftWidth = Math.floor((availableWidth - labelWidth) / 2);
		return "─".repeat(leftWidth) + label + "─".repeat(availableWidth - leftWidth - labelWidth);
	}

	const indicator = `─── ${direction} ${hiddenLineCount} more `;
	const remaining = availableWidth - visibleWidth(indicator);
	if (remaining >= 0) return indicator + "─".repeat(remaining);

	const ellipsis = "...".slice(0, availableWidth);
	const indicatorWidth = availableWidth - visibleWidth(ellipsis);
	return sliceByColumn(indicator, 0, indicatorWidth, true) + ellipsis;
}

export class Editor implements Component, Focusable {
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** Focusable 接口——由 TUI 在 focus 变化时设置 */
	focused: boolean = false;

	protected tui: TUI;
	private theme: EditorTheme;
	private paddingX: number = 0;

	// 保存上次渲染的几何信息，用于光标导航和鼠标命中测试。
	private lastWidth: number = 80;
	private renderedVisibleLineCount = 1;
	private renderedAutocompleteHeight = 0;

	// 垂直滚动支持
	private scrollOffset: number = 0;

	// 边框颜色（可动态修改）
	public borderColor: (str: string) => string;

	// 自动补全支持
	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteTriggerCharacters = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
	private autocompleteTriggerPattern = buildTriggerPattern(this.autocompleteTriggerCharacters);
	private autocompleteDebouncePattern = buildDebouncePattern(this.autocompleteTriggerCharacters);
	private autocompleteList?: SelectList;
	private autocompleteState: "regular" | "force" | null = null;
	private autocompletePrefix: string = "";
	private autocompleteMaxVisible: number = 5;
	private autocompleteAbort?: AbortController;
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	private autocompleteRequestTask: Promise<void> = Promise.resolve();
	private autocompleteStartToken: number = 0;
	private autocompleteRequestId: number = 0;

	// 大段粘贴的跟踪
	private pastes: Map<number, string> = new Map();
	private pasteCounter: number = 0;

	// bracketed paste 模式的缓冲
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// 用于 up/down 导航的提示历史
	private history: string[] = [];
	private historyIndex: number = -1; // -1 = 未在浏览，0 = 最新一条，1 = 更早一条，依此类推
	private historyDraft: EditorState | null = null;

	// Emacs 风格 kill/yank 操作的 kill ring
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// 字符跳转模式
	private jumpMode: "forward" | "backward" | null = null;

	// 垂直移动光标时偏好的可视列（sticky column）
	private preferredVisualCol: number | null = null;

	// 当光标被吸附到某个原子 segment（例如 paste marker）的开头时，
	// cursorCol 已不再反映光标原本应落点的位置。此字段保存吸附前的
	// cursorCol，以便下一次垂直移动能把它解析为所属 VL 上的可视列。
	private snappedFromCursorCol: number | null = null;

	// 撤销支持
	private undoStack = new UndoStack<EditorSnapshot>();

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.borderColor = theme.borderColor;
		const paddingX = options.paddingX ?? 0;
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
	}

	/** 当前合法的粘贴 ID 集合，用于带标记感知的分词。 */
	private validPasteIds(): Set<number> {
		return new Set(this.pastes.keys());
	}

	/** 带粘贴标记感知地切分文本，只合并 ID 合法的标记。 */
	private segment(text: string, mode: "word" | "grapheme"): Iterable<Intl.SegmentData> {
		return segmentWithMarkers(text, mode === "word" ? wordSegmenter : graphemeSegmenter, this.validPasteIds());
	}

	getPaddingX(): number {
		return this.paddingX;
	}

	setPaddingX(padding: number): void {
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		if (this.paddingX !== newPadding) {
			this.paddingX = newPadding;
			this.tui.requestRender();
		}
	}

	getAutocompleteMaxVisible(): number {
		return this.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.autocompleteMaxVisible !== newMaxVisible) {
			this.autocompleteMaxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.autocompleteProvider = provider;
		this.setAutocompleteTriggerCharacters(provider.triggerCharacters ?? []);
	}

	/**
	 * 把一条提示加入历史，供上/下方向键导航。
	 * 在成功提交后调用。
	 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// 不添加连续重复项
		if (this.history.length > 0 && this.history[0] === trimmed) return;
		this.history.unshift(trimmed);
		// 限制历史大小
		if (this.history.length > 100) {
			this.history.pop();
		}
	}

	private isEditorEmpty(): boolean {
		return this.state.lines.length === 1 && this.state.lines[0] === "";
	}

	private isOnFirstVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	private isOnLastVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	private navigateHistory(direction: 1 | -1): void {
		this.lastAction = null;
		if (this.history.length === 0) return;

		const newIndex = this.historyIndex - direction; // Up(-1) 递增索引，Down(1) 递减
		if (newIndex < -1 || newIndex >= this.history.length) return;

		// 首次进入历史浏览模式时捕获状态
		if (this.historyIndex === -1 && newIndex >= 0) {
			this.pushUndoSnapshot();
			this.historyDraft = structuredClone(this.state);
		}

		this.historyIndex = newIndex;

		if (this.historyIndex === -1) {
			const draft = this.historyDraft;
			this.historyDraft = null;
			if (draft) {
				this.state = draft;
				this.preferredVisualCol = null;
				this.snappedFromCursorCol = null;
				this.scrollOffset = 0;
				if (this.onChange) this.onChange(this.getText());
			} else {
				this.setTextInternal("");
			}
		} else {
			this.setTextInternal(this.history[this.historyIndex] || "", direction === -1 ? "start" : "end");
		}
	}

	private exitHistoryBrowsing(): void {
		this.historyIndex = -1;
		this.historyDraft = null;
	}

	/** 内部的 setText，不重置历史状态——由 navigateHistory 使用 */
	private setTextInternal(text: string, cursorPlacement: "start" | "end" = "end"): void {
		const lines = text.split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = cursorPlacement === "start" ? 0 : this.state.lines.length - 1;
		this.setCursorCol(cursorPlacement === "start" ? 0 : this.state.lines[this.state.cursorLine]?.length || 0);
		// 重置滚动——render() 会调整以显示光标
		this.scrollOffset = 0;

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	invalidate(): void {
		// 当前没有需要失效的缓存状态
	}

	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		const border = hiddenLineCount > 0 ? createScrollBorder("↑", hiddenLineCount, width) : "─".repeat(width);
		return this.borderColor(border);
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		const border = hiddenLineCount > 0 ? createScrollBorder("↓", hiddenLineCount, width) : "─".repeat(width);
		return this.borderColor(border);
	}

	render(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.paddingX, maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// 布局宽度：有 padding 时光标可以溢出到 padding 区域，
		// 没有 padding 时则要为光标预留 1 列。
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		// 保存下来供光标导航使用（必须与换行宽度一致）
		this.lastWidth = layoutWidth;

		// 对文本做布局
		const layoutLines = this.layoutText(layoutWidth);

		// 计算最大可见行数：终端高度的 30%，至少 5 行
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		// 在 layoutLines 中找到光标所在行的索引
		let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		if (cursorLineIndex === -1) cursorLineIndex = 0;

		// 调整滚动偏移，让光标保持可见
		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		// 把滚动偏移限制到合法范围
		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

		// 取可见行的切片
		const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);
		this.renderedVisibleLineCount = visibleLines.length;

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;

		// 渲染顶部边框（若已向下滚动则带滚动指示）
		result.push(this.renderTopBorder(width, this.scrollOffset));

		// 渲染每条可见的布局行
		// 获得焦点时发出硬件光标标记，使 TUI 能够定位硬件光标，
		// 供 IME 候选窗口放置使用——即使 autocomplete（如 slash 命令菜单）
		// 正在显示也是如此。
		const emitCursorMarker = this.focused;

		for (const layoutLine of visibleLines) {
			let displayText = layoutLine.text;
			let lineVisibleWidth = visibleWidth(layoutLine.text);
			let cursorInPadding = false;

			// 若该行有光标则添加光标
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				// 硬件光标标记（零宽，在 fake cursor 之前发出，用于 IME 定位）
				const marker = emitCursorMarker ? CURSOR_MARKER : "";

				if (after.length > 0) {
					// 光标位于某个字符（grapheme）上——用高亮版本替换它
					// 从 'after' 中取出第一个 grapheme
					const afterGraphemes = [...this.segment(after, "grapheme")];
					const firstGrapheme = afterGraphemes[0]?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = renderFakeCursor(firstGrapheme);
					displayText = before + marker + cursor + restAfter;
					// lineVisibleWidth 保持不变——这是替换而非添加
				} else {
					// 光标位于行尾——添加一个高亮空格
					const cursor = renderFakeCursor(" ");
					displayText = before + marker + cursor;
					lineVisibleWidth = lineVisibleWidth + 1;
					// 若光标溢出内容宽度进入 padding 区域，需做标记
					if (lineVisibleWidth > contentWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			// 按实际可见宽度计算 padding
			const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			// 渲染该行（没有侧边框，只有上下的水平线）
			result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);
		}

		// 渲染底部边框（若下方还有内容则带滚动指示）
		const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
		result.push(this.renderBottomBorder(width, linesBelow));

		// 若自动补全列表处于激活状态则渲染它
		this.renderedAutocompleteHeight = 0;
		if (this.autocompleteState && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(contentWidth);
			this.renderedAutocompleteHeight = autocompleteResult.length;
			for (const line of autocompleteResult) {
				const lineWidth = visibleWidth(line);
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		return result;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const autocompleteStartRow = this.renderedVisibleLineCount + 2;
		if (
			this.autocompleteState &&
			this.autocompleteList &&
			event.y >= autocompleteStartRow &&
			event.y < autocompleteStartRow + this.renderedAutocompleteHeight
		) {
			const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
			const paddingX = Math.min(this.paddingX, maxPadding);
			const contentWidth = Math.max(1, event.width - paddingX * 2);
			const result = this.autocompleteList.handleMouse?.({
				...event,
				x: event.x - paddingX,
				y: event.y - autocompleteStartRow,
				width: contentWidth,
				height: this.renderedAutocompleteHeight,
			});
			return result ? { ...result, focus: true } : undefined;
		}

		// 不处理 press/drag/release，让渲染器的屏幕级文本选择
		// 能覆盖 editor 区域（拖动选择，松开复制）。
		// 当 press 与 release 落在同一单元格且无移动时，渲染器会
		// 合成一个 click，这正是定位光标的手势。
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y <= 0 || event.y > this.renderedVisibleLineCount) return { handled: true, focus: true };

		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const visualLineIndex = this.scrollOffset + event.y - 1;
		const visualLine = visualLines[visualLineIndex];
		if (!visualLine) return { handled: true, focus: true };
		const logicalLine = this.state.lines[visualLine.logicalLine] ?? "";
		const chunkEnd = visualLine.startCol + visualLine.length;
		const chunk = logicalLine.slice(visualLine.startCol, chunkEnd);
		const maxPadding = Math.max(0, Math.floor((event.width - 1) / 2));
		const paddingX = Math.min(this.paddingX, maxPadding);
		const targetColumn = Math.max(0, event.x - paddingX);
		let visibleColumn = 0;
		let targetIndex = chunk.length;
		let lastGraphemeIndex = 0;
		for (const grapheme of this.segment(chunk, "grapheme")) {
			const nextColumn = visibleColumn + visibleWidth(grapheme.segment);
			lastGraphemeIndex = grapheme.index;
			if (targetColumn < nextColumn) {
				targetIndex = grapheme.index;
				break;
			}
			visibleColumn = nextColumn;
		}
		const isLastSegment =
			visualLineIndex === visualLines.length - 1 ||
			visualLines[visualLineIndex + 1]?.logicalLine !== visualLine.logicalLine;
		if (!isLastSegment && targetIndex === chunk.length && chunk.length > 0) targetIndex = lastGraphemeIndex;

		this.state.cursorLine = visualLine.logicalLine;
		this.setCursorCol(visualLine.startCol + targetIndex);
		this.lastAction = null;
		this.exitHistoryBrowsing();
		if (this.autocompleteState) this.updateAutocomplete();
		return { handled: true, focus: true };
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// 处理字符跳转模式（等待下一个要跳转的字符）
		if (this.jumpMode !== null) {
			// 再次按下热键则取消
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.jumpMode = null;
				return;
			}

			const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
			if (printable !== undefined) {
				// 可打印字符——执行跳转
				const direction = this.jumpMode;
				this.jumpMode = null;
				this.jumpToChar(printable, direction);
				return;
			}

			// 控制字符——取消跳转模式，落入正常处理流程
			this.jumpMode = null;
		}

		// 处理 bracketed paste 模式
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		if (this.isInPaste) {
			this.pasteBuffer += data;
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				if (pasteContent.length > 0) {
					this.handlePaste(pasteContent);
				}
				this.isInPaste = false;
				const remaining = this.pasteBuffer.substring(endIndex + 6);
				this.pasteBuffer = "";
				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			}
			return;
		}

		// Ctrl+C——交给父级处理（退出/清除）
		if (kb.matches(data, "tui.input.copy")) {
			return;
		}

		// 撤销
		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		// 处理自动补全模式
		if (this.autocompleteState && this.autocompleteList) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.cancelAutocomplete();
				return;
			}

			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
				this.autocompleteList.handleInput(data);
				return;
			}

			if (kb.matches(data, "tui.input.tab")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);
					this.cancelAutocomplete();
					if (this.onChange) this.onChange(this.getText());
				}
				return;
			}

			if (kb.matches(data, "tui.select.confirm")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);

					if (this.autocompletePrefix.startsWith("/")) {
						this.cancelAutocomplete();
						// 落入提交流程
					} else {
						this.cancelAutocomplete();
						if (this.onChange) this.onChange(this.getText());
						return;
					}
				}
			}
		}

		// Tab——触发补全
		if (kb.matches(data, "tui.input.tab") && !this.autocompleteState) {
			this.handleTabCompletion();
			return;
		}

		// 删除类操作
		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToEndOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToStartOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.deleteWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.deleteWordForward();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.handleBackspace();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.handleForwardDelete();
			return;
		}

		// Kill ring 操作
		if (kb.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.yankPop();
			return;
		}

		// 专门的历史操作总是浏览历史条目，而不是移动光标。
		if (kb.matches(data, "tui.editor.historyPrevious")) {
			this.cancelAutocomplete();
			this.navigateHistory(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.historyNext")) {
			this.cancelAutocomplete();
			this.navigateHistory(1);
			return;
		}

		// 光标移动操作
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.moveToLineStart();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.moveToLineEnd();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		// 换行
		if (
			kb.matches(data, "tui.input.newLine") ||
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1)
		) {
			if (this.shouldSubmitOnBackslashEnter(data, kb)) {
				this.handleBackspace();
				this.submitValue();
				return;
			}
			this.addNewLine();
			return;
		}

		// 提交（Enter）
		if (kb.matches(data, "tui.input.submit")) {
			if (this.disableSubmit) return;

			// 针对不支持 Shift+Enter 的终端的变通方案：
			// 若光标前的字符是 \，则删除它并插入换行，而不是提交。
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			if (this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\") {
				this.handleBackspace();
				this.addNewLine();
				return;
			}

			this.submitValue();
			return;
		}

		// 方向键导航（带历史支持）
		if (kb.matches(data, "tui.editor.cursorUp")) {
			if (
				this.isOnFirstVisualLine() &&
				(this.isEditorEmpty() || this.historyIndex > -1 || this.state.cursorCol === 0)
			) {
				this.navigateHistory(-1);
			} else if (this.isOnFirstVisualLine()) {
				// 已在顶部——跳到行首
				this.moveToLineStart();
			} else {
				this.moveCursor(-1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorDown")) {
			if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
				this.navigateHistory(1);
			} else if (this.isOnLastVisualLine()) {
				// 已在底部——跳到行尾
				this.moveToLineEnd();
			} else {
				this.moveCursor(1, 0);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.moveCursor(0, 1);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.moveCursor(0, -1);
			return;
		}

		// Page up/down——按页滚动并移动光标
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.pageScroll(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.pageScroll(1);
			return;
		}

		// 字符跳转模式触发器
		if (kb.matches(data, "tui.editor.jumpForward")) {
			this.jumpMode = "forward";
			return;
		}
		if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.jumpMode = "backward";
			return;
		}

		// Shift+Space——插入普通空格
		if (matchesKey(data, "shift+space")) {
			this.insertCharacter(" ");
			return;
		}

		const printable = decodePrintableKey(data);
		if (printable !== undefined) {
			this.insertCharacter(printable);
			return;
		}

		// 普通字符
		if (data.charCodeAt(0) >= 32) {
			this.insertCharacter(data);
		}
	}

	private layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			// editor 为空
			layoutLines.push({
				text: "",
				hasCursor: true,
				cursorPos: 0,
			});
			return layoutLines;
		}

		// 逐条处理逻辑行
		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const isCurrentLine = i === this.state.cursorLine;
			const lineVisibleWidth = visibleWidth(line);

			if (lineVisibleWidth <= contentWidth) {
				// 整行可容纳于一条布局行
				if (isCurrentLine) {
					layoutLines.push({
						text: line,
						hasCursor: true,
						cursorPos: this.state.cursorCol,
					});
				} else {
					layoutLines.push({
						text: line,
						hasCursor: false,
					});
				}
			} else {
				// 该行需要换行——使用感知单词边界的折行
				const chunks = wordWrapLine(line, contentWidth, [...this.segment(line, "grapheme")]);

				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					const chunk = chunks[chunkIndex];
					if (!chunk) continue;

					const cursorPos = this.state.cursorCol;
					const isLastChunk = chunkIndex === chunks.length - 1;

					// 判断光标是否在本 chunk 中
					// 对于 word wrap 过的 chunk，需要处理光标
					// 位于 chunk 末尾被裁剪空白中的情况
					let hasCursorInChunk = false;
					let adjustedCursorPos = 0;

					if (isCurrentLine) {
						if (isLastChunk) {
							// 最后一个 chunk：光标位置 >= startIndex 即归属此处
							hasCursorInChunk = cursorPos >= chunk.startIndex;
							adjustedCursorPos = cursorPos - chunk.startIndex;
						} else {
							// 非最后的 chunk：光标位置在 [startIndex, endIndex) 中即归属此处
							// 但还需要处理被裁剪文本中的可视化位置
							hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
							if (hasCursorInChunk) {
								adjustedCursorPos = cursorPos - chunk.startIndex;
								// 收敛到文本长度（防止光标位于被裁剪的空白中）
								if (adjustedCursorPos > chunk.text.length) {
									adjustedCursorPos = chunk.text.length;
								}
							}
						}
					}

					if (hasCursorInChunk) {
						layoutLines.push({
							text: chunk.text,
							hasCursor: true,
							cursorPos: adjustedCursorPos,
						});
					} else {
						layoutLines.push({
							text: chunk.text,
							hasCursor: false,
						});
					}
				}
			}
		}

		return layoutLines;
	}

	getText(): string {
		return this.state.lines.join("\n");
	}

	private expandPasteMarkers(text: string): string {
		let result = text;
		for (const [pasteId, pasteContent] of this.pastes) {
			const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			result = result.replace(markerRegex, () => pasteContent);
		}
		return result;
	}

	/**
	 * 获取文本，并把粘贴标记展开为其实际内容。
	 * 当你需要完整内容时使用（例如交给外部 editor）。
	 */
	getExpandedText(): string {
		return this.expandPasteMarkers(this.state.lines.join("\n"));
	}

	getLines(): string[] {
		return [...this.state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}

	setText(text: string): void {
		this.cancelAutocomplete();
		this.lastAction = null;
		this.exitHistoryBrowsing();
		const normalized = this.normalizeText(text);
		// 若内容有差异则压入撤销快照（使程序化修改可撤销）
		if (this.getText() !== normalized) {
			this.pushUndoSnapshot();
		}
		this.pastes.clear();
		this.pasteCounter = 0;
		this.setTextInternal(normalized);
	}

	/**
	 * 在当前光标位置插入文本。
	 * 用于程序化插入（例如剪贴板图片标记）。
	 * 这对撤销是原子的——单次撤销即恢复插入前的完整状态。
	 */
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.cancelAutocomplete();
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.exitHistoryBrowsing();
		this.insertTextAtCursorInternal(text);
	}

	/**
	 * 为存入 editor 做文本归一化：
	 * - 归一化换行符（\r\n 和 \r -> \n）
	 * - 把 tab 展开为 4 个空格
	 */
	private normalizeText(text: string): string {
		return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	}

	/**
	 * 在光标处做内部文本插入。处理单行与多行文本。
	 * 不压入撤销快照、不触发自动补全——由调用方负责。
	 * 最后会归一化换行符并调用一次 onChange。
	 */
	private insertTextAtCursorInternal(text: string): void {
		if (!text) return;

		// 归一化换行符与 tab
		const normalized = this.normalizeText(text);
		const insertedLines = normalized.split("\n");

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		if (insertedLines.length === 1) {
			// 单行——在光标位置插入
			this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
			this.setCursorCol(this.state.cursorCol + normalized.length);
		} else {
			// 多行插入
			this.state.lines = [
				// 当前行之前的所有行
				...this.state.lines.slice(0, this.state.cursorLine),

				// 插入的第一行，与光标前的文本合并
				beforeCursor + insertedLines[0],

				// 中间插入的所有行
				...insertedLines.slice(1, -1),

				// 插入的最后一行，与光标后的文本合并
				insertedLines[insertedLines.length - 1] + afterCursor,

				// 当前行之后的所有行
				...this.state.lines.slice(this.state.cursorLine + 1),
			];

			this.state.cursorLine += insertedLines.length - 1;
			this.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	// ……以下是 editor 的各个方法
	private insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		this.exitHistoryBrowsing();

		// 撤销合并（fish 风格）：
		// - 连续的单词字符合并为一个撤销单元
		// - 空格在输入前先捕获状态（因此撤销时会一并移除空格及其后的单词）
		// - 每个空格都可单独撤销
		// 由原子操作（如 handlePaste）调用时跳过合并
		if (!skipUndoCoalescing) {
			if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
				this.pushUndoSnapshot();
			}
			this.lastAction = "type-word";
		}

		const line = this.state.lines[this.state.cursorLine] || "";

		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.setCursorCol(this.state.cursorCol + char.length);

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// 检查是否应触发或更新自动补全
		if (!this.autocompleteState) {
			// 行首输入 "/" 时自动触发（slash 命令）
			if (char === "/" && this.isAtStartOfMessage()) {
				this.tryTriggerAutocomplete();
			}
			// 在 token 边界输入 @、# 或 provider 触发符时自动触发的基于符号的补全
			else if (this.autocompleteTriggerCharacters.includes(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
			}
			// 在 slash 命令或由符号触发的补全上下文中输入字母时同样自动触发
			else if (/[a-zA-Z0-9.\-_]/.test(char) || cjkBreakRegex.test(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// 检查是否处于 slash 命令中（参数前带或不带空格均可）
				if (this.isInSlashCommandContext(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
				// 检查是否处于 @、# 或 provider 触发符的基于符号的补全上下文
				else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
			}
		} else {
			this.updateAutocomplete();
		}
	}

	private handlePaste(pastedText: string): void {
		this.cancelAutocomplete();
		this.exitHistoryBrowsing();
		this.lastAction = null;

		this.pushUndoSnapshot();

		// 某些终端（例如设置了 extended-keys-format=csi-u 的 tmux popup）会把
		// bracketed paste 中的控制字节重新编码为 CSI-u Ctrl+<letter> 序列
		// （ESC [ <codepoint> ; 5 u）。把它们解码回字面字节，使下方的
		// 逐字符过滤保留换行符，而不是剥离 ESC 后把可打印尾部
		// （例如 "[106;5u"）泄漏进 editor。
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});

		// 清理粘贴的文本：归一化换行符，展开 tab
		const cleanText = this.normalizeText(decodedText);

		// 过滤掉不可打印字符，保留换行符
		let filteredText = cleanText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");

		// 粘贴文件路径时（以 /、~ 或 . 开头），若光标前的字符
		// 是单词字符，则在前面加一个空格以提升可读性
		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		// 切分为多行以判断是否为大段粘贴
		const pastedLines = filteredText.split("\n");

		// 判断是否为大段粘贴（> 10 行或 > 1000 字符）
		const totalChars = filteredText.length;
		if (pastedLines.length > 10 || totalChars > 1000) {
			// 记录粘贴内容并插入标记
			this.pasteCounter++;
			const pasteId = this.pasteCounter;
			this.pastes.set(pasteId, filteredText);

			// 插入形如 "[paste #1 +123 lines]" 或 "[paste #1 1234 chars]" 的标记
			const marker =
				pastedLines.length > 10
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			this.insertTextAtCursorInternal(marker);
			return;
		}

		if (pastedLines.length === 1) {
			// 单行——原子插入（粘贴期间不触发自动补全）
			this.insertTextAtCursorInternal(filteredText);
			return;
		}

		// 多行粘贴——直接操作状态
		this.insertTextAtCursorInternal(filteredText);
	}

	private addNewLine(): void {
		this.cancelAutocomplete();
		this.exitHistoryBrowsing();
		this.lastAction = null;

		this.pushUndoSnapshot();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		// 拆分当前行
		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		// 把光标移到新行的开头
		this.state.cursorLine++;
		this.setCursorCol(0);

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private shouldSubmitOnBackslashEnter(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		return this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\";
	}

	private submitValue(): void {
		this.cancelAutocomplete();
		const result = this.expandPasteMarkers(this.state.lines.join("\n")).trim();

		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.pastes.clear();
		this.pasteCounter = 0;
		this.exitHistoryBrowsing();
		this.scrollOffset = 0;
		this.undoStack.clear();
		this.lastAction = null;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	private handleBackspace(): void {
		this.exitHistoryBrowsing();
		this.lastAction = null;

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// 删除光标前的 grapheme（处理 emoji、组合字符等）
			let line = this.state.lines[this.state.cursorLine] || "";
			const beforeCursor = line.slice(0, this.state.cursorCol);

			// 在光标前的文本中找出最后一个 grapheme
			const graphemes = [...this.segment(beforeCursor, "grapheme")];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			const isPastedSegmented = PASTE_MARKER_SINGLE.exec(lastGrapheme.segment);

			if (isPastedSegmented) {
				// 这里包含 ID 部分，例如 [paste #4 +123 lines] 中的 4
				const targetId = Number(isPastedSegmented[1]);
				this.pastes.delete(targetId);
				this.pasteCounter--;

				// 按 ID 升序下移注册表条目，独立于标记在文本中的
				// 顺序（移除 [paste #1] 后，[paste #3] 变为
				// [paste #2]）。
				const higherIds = [...this.pastes.keys()].filter((id) => id > targetId).sort((a, b) => a - b);
				for (const id of higherIds) {
					this.pastes.set(id - 1, this.pastes.get(id)!);
					this.pastes.delete(id);
				}

				// 为 ID 大于被移除标记的标记重新编号。
				this.state.lines = this.state.lines.map((line) =>
					line.replace(PASTE_MARKER_REGEX, (fullMatch, idGroup, suffixGroup) => {
						const x = Number(idGroup);
						if (x <= targetId) return fullMatch;
						return `[paste #${x - 1}${suffixGroup}]`;
					}),
				);
			}

			line = this.state.lines[this.state.cursorLine] || "";

			const before = line.slice(0, this.state.cursorCol - graphemeLength);
			const after = line.slice(this.state.cursorCol);

			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - graphemeLength);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// 与上一行合并
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// 退格后更新或重新触发自动补全
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			// 若自动补全已被取消（无匹配项），且当前处于可补全上下文则重新触发
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// slash 命令上下文
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// @、# 或 provider 触发符的基于符号的补全上下文
			else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * 设置光标列并清空 preferredVisualCol。
	 * 所有非垂直移动的光标操作都应使用它，以重置 sticky column 行为。
	 */
	private setCursorCol(col: number): void {
		this.state.cursorCol = col;
		this.preferredVisualCol = null;
		this.snappedFromCursorCol = null;
	}

	/**
	 * 把光标移动到目标可视行，应用 sticky column 逻辑。
	 * 由 moveCursor() 和 pageScroll() 共用。
	 */
	private moveToVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];
		if (!(currentVL && targetVL)) return;

		// 当光标曾被吸附到某个 segment 开头时，把吸附前的位置
		// 解析到其所属的 VL 上。即使 resize 重新排列了 VL，
		// 也能得到正确的可视列。
		let currentVisualCol: number;
		if (this.snappedFromCursorCol !== null) {
			const vlIndex = this.findVisualLineAt(visualLines, currentVL.logicalLine, this.snappedFromCursorCol);
			currentVisualCol = this.snappedFromCursorCol - visualLines[vlIndex].startCol;
		} else {
			currentVisualCol = this.state.cursorCol - currentVL.startCol;
		}

		// 对非最后的段，收敛到 length-1 以留在本段之内
		const isLastSourceSegment =
			currentVisualLine === visualLines.length - 1 ||
			visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
		const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);

		const isLastTargetSegment =
			targetVisualLine === visualLines.length - 1 ||
			visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
		const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);

		const moveToVisualCol = this.computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol);

		// 设置光标位置
		this.state.cursorLine = targetVL.logicalLine;
		const targetCol = targetVL.startCol + moveToVisualCol;
		const logicalLine = this.state.lines[targetVL.logicalLine] || "";
		this.state.cursorCol = Math.min(targetCol, logicalLine.length);

		// 把光标吸附到原子 segment 边界（例如粘贴标记），
		// 使光标不会落在多 grapheme 单元的中间。
		// 单 grapheme 的 segment 无需吸附。
		const segments = [...this.segment(logicalLine, "grapheme")];
		for (const seg of segments) {
			if (seg.index > this.state.cursorCol) break;
			if (seg.segment.length <= 1) continue;
			if (this.state.cursorCol < seg.index + seg.segment.length) {
				const isContinuation = seg.index < targetVL.startCol;
				const isMovingDown = targetVisualLine > currentVisualLine;

				if (isContinuation && isMovingDown) {
					// 该 segment 开始于上一条可视行，向下经过时
					// 已经访问过它。跳过所有剩余的续行，落在
					// 其后的第一条 VL 上。
					const segEnd = seg.index + seg.segment.length;
					let next = targetVisualLine + 1;
					while (
						next < visualLines.length &&
						visualLines[next].logicalLine === targetVL.logicalLine &&
						visualLines[next].startCol < segEnd
					) {
						next++;
					}
					if (next < visualLines.length) {
						this.moveToVisualLine(visualLines, currentVisualLine, next);
						return;
					}
				}

				// 吸附到 segment 的开头使其获得高亮。
				// 保存吸附前的位置，以便下一次垂直移动
				// 能解析出正确的可视列。
				this.snappedFromCursorCol = this.state.cursorCol;
				this.state.cursorCol = seg.index;
				return;
			}
		}

		// 未发生吸附——已移出原子 segment。
		this.snappedFromCursorCol = null;
	}

	/**
	 * 为垂直光标移动计算目标可视列。
	 * 实现 sticky column 的决策表：
	 *
	 * | P | S | T | U | 场景                                                 | 设置 Preferred | 移动到      |
	 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
	 * | 0 | * | 0 | - | 开始导航，目标行足够容纳                              | null          | 当前位置    |
	 * | 0 | * | 1 | - | 开始导航，目标行更短                                  | current       | 目标行末尾  |
	 * | 1 | 0 | 0 | 0 | 已收敛，目标行能容纳 preferred                        | null          | preferred   |
	 * | 1 | 0 | 0 | 1 | 已收敛，目标行更长但仍容纳不下 preferred              | keep          | 目标行末尾  |
	 * | 1 | 0 | 1 | - | 已收敛，目标行更短                                    | keep          | 目标行末尾  |
	 * | 1 | 1 | 0 | - | 已重新换行，目标行能容纳当前列                        | null          | 当前位置    |
	 * | 1 | 1 | 1 | - | 已重新换行，目标行比当前列更短                        | current       | 目标行末尾  |
	 *
	 * 其中：
	 * - P = preferred 列已设置
	 * - S = 光标位于源行中部（未收敛到行尾）
	 * - T = 目标行比当前可视列更短
	 * - U = 目标行比 preferred 列更短
	 */
	private computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.preferredVisualCol !== null; // P
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
		const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				// 情形 2 和 7
				this.preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}

			// 情形 1 和 6
			this.preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol!; // U
		if (targetTooShort || targetCantFitPreferred) {
			// 情形 4 和 5
			return targetMaxVisualCol;
		}

		// 情形 3
		const result = this.preferredVisualCol!;
		this.preferredVisualCol = null;
		return result;
	}

	private moveToLineStart(): void {
		this.lastAction = null;
		this.setCursorCol(0);
	}

	private moveToLineEnd(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.setCursorCol(currentLine.length);
	}

	private deleteToStartOfLine(): void {
		this.exitHistoryBrowsing();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// 计算要删除的文本并存入 kill ring（向后删除 = 前插）
			const deletedText = currentLine.slice(0, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// 从行首删除到光标处
			this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
			this.setCursorCol(0);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// 位于行首——与上一行合并，把换行符视为被删除的文本
			this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteToEndOfLine(): void {
		this.exitHistoryBrowsing();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// 计算要删除的文本并存入 kill ring（向前删除 = 追加）
			const deletedText = currentLine.slice(this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// 从光标处删除到行尾
			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// 位于行尾——与下一行合并，把换行符视为被删除的文本
			this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordBackwards(): void {
		this.exitHistoryBrowsing();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// 若在行首，行为如同列 0 处的退格（与上一行合并）
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.pushUndoSnapshot();

				// 把换行符视为被删除的文本（向后删除 = 前插）
				this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
				this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
				this.state.lines.splice(this.state.cursorLine, 1);
				this.state.cursorLine--;
				this.setCursorCol(previousLine.length);
			}
		} else {
			this.pushUndoSnapshot();

			// 在光标移动前保存 lastAction（moveWordBackwards 会重置它）
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordBackwards();
			const deleteFrom = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(deleteFrom, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
			this.setCursorCol(deleteFrom);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordForward(): void {
		this.exitHistoryBrowsing();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// 若在行尾，与下一行合并（删除换行符）
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.pushUndoSnapshot();

				// 把换行符视为被删除的文本（向前删除 = 追加）
				this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
				this.state.lines[this.state.cursorLine] = currentLine + nextLine;
				this.state.lines.splice(this.state.cursorLine + 1, 1);
			}
		} else {
			this.pushUndoSnapshot();

			// 在光标移动前保存 lastAction（moveWordForwards 会重置它）
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordForwards();
			const deleteTo = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(this.state.cursorCol, deleteTo);
			this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, this.state.cursorCol) + currentLine.slice(deleteTo);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private handleForwardDelete(): void {
		this.exitHistoryBrowsing();
		this.lastAction = null;

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// 删除光标处的 grapheme（处理 emoji、组合字符等）
			const afterCursor = currentLine.slice(this.state.cursorCol);

			// 找出光标处的第一个 grapheme
			const graphemes = [...this.segment(afterCursor, "grapheme")];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + graphemeLength);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// 位于行尾——与下一行合并
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// 向前删除后更新或重新触发自动补全
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// slash 命令上下文
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// @、# 或 provider 触发符的基于符号的补全上下文
			else if (this.autocompleteTriggerPattern.test(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * 构建可视行到逻辑位置的映射。
	 * 返回一个数组，每个元素代表一条可视行，包含：
	 * - logicalLine：this.state.lines 的索引
	 * - startCol：在逻辑行中的起始列
	 * - length：该可视行段的长度
	 */
	private buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const lineVisWidth = visibleWidth(line);
			if (line.length === 0) {
				// 空行仍占一条可视行
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
			} else if (lineVisWidth <= width) {
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
			} else {
				// 该行需要换行——使用感知单词边界的折行
				const chunks = wordWrapLine(line, width, [...this.segment(line, "grapheme")]);
				for (const chunk of chunks) {
					visualLines.push({
						logicalLine: i,
						startCol: chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		return visualLines;
	}

	/**
	 * 找到包含给定逻辑位置的可视行索引。
	 */
	private findVisualLineAt(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		line: number,
		col: number,
	): number {
		for (let i = 0; i < visualLines.length; i++) {
			const vl = visualLines[i];
			if (!vl || vl.logicalLine !== line) continue;
			const offset = col - vl.startCol;
			// 若光标位于范围内，则属于该 segment。对于逻辑行的最后
			// 一个 segment，光标可以位于 length（结束位置）
			const isLastSegmentOfLine = i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
			if (offset >= 0 && (offset < vl.length || (isLastSegmentOfLine && offset === vl.length))) {
				return i;
			}
		}
		return visualLines.length - 1;
	}

	/**
	 * 找到当前光标位置对应的可视行索引。
	 */
	private findCurrentVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
	): number {
		return this.findVisualLineAt(visualLines, this.state.cursorLine, this.state.cursorCol);
	}

	private moveCursor(deltaLine: number, deltaCol: number): void {
		this.lastAction = null;
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);

		if (deltaLine !== 0) {
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";

			if (deltaCol > 0) {
				// 向右移动——按一个 grapheme 移动（处理 emoji、组合字符等）
				if (this.state.cursorCol < currentLine.length) {
					const afterCursor = currentLine.slice(this.state.cursorCol);
					const graphemes = [...this.segment(afterCursor, "grapheme")];
					const firstGrapheme = graphemes[0];
					this.setCursorCol(this.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
				} else if (this.state.cursorLine < this.state.lines.length - 1) {
					// 依折行进入下一条逻辑行的开头
					this.state.cursorLine++;
					this.setCursorCol(0);
				} else {
					// 位于最后一行的行尾——无法移动，但为上/下导航设置 preferredVisualCol
					const currentVL = visualLines[currentVisualLine];
					if (currentVL) {
						this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
					}
				}
			} else {
				// 向左移动——按一个 grapheme 移动（处理 emoji、组合字符等）
				if (this.state.cursorCol > 0) {
					const beforeCursor = currentLine.slice(0, this.state.cursorCol);
					const graphemes = [...this.segment(beforeCursor, "grapheme")];
					const lastGrapheme = graphemes[graphemes.length - 1];
					this.setCursorCol(this.state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
				} else if (this.state.cursorLine > 0) {
					// 依折行回到上一条逻辑行的行尾
					this.state.cursorLine--;
					const prevLine = this.state.lines[this.state.cursorLine] || "";
					this.setCursorCol(prevLine.length);
				}
			}
		}

		// 让处于打开状态的自动补全列表跟随新的光标位置：
		// 光标移动改变了光标之前的文本，因此为旧位置计算的列表已过期。
		// 重新查询使其刷新——或在新位置没有任何建议时关闭——
		// 与 insertCharacter()/handleBackspace() 的行为一致。否则，从
		// `/cmd ` 向左移回命令名时，参数列表仍会显示在 `/cmd` 前缀上
		// （此时按 Tab 会把过期的建议拼接到不完整的命令名上）。
		if (this.autocompleteState) {
			this.updateAutocomplete();
		}
	}

	/**
	 * 按页滚动（direction：-1 向上，1 向下）。
	 * 按页幅移动光标，同时保持其在边界之内。
	 */
	private pageScroll(direction: -1 | 1): void {
		this.lastAction = null;
		const terminalRows = this.tui.terminal.rows;
		const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * pageSize));

		this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	private moveWordBackwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// 若在行首，则移动到上一行的行尾
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				const prevLine = this.state.lines[this.state.cursorLine] || "";
				this.setCursorCol(prevLine.length);
			}
			return;
		}

		this.setCursorCol(
			findWordBackward(currentLine, this.state.cursorCol, {
				segment: (text) => this.segment(text, "word"),
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	/**
	 * 在光标处 yank（粘贴）kill ring 中最近的条目。
	 */
	private yank(): void {
		if (this.killRing.length === 0) return;

		this.pushUndoSnapshot();

		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * 在 kill ring 中循环（仅在 yank 或 yank-pop 之后立即有效）。
	 * 用 ring 中的上一个条目替换最后 yank 的文本。
	 */
	private yankPop(): void {
		// 仅在刚执行过 yank 且 ring 中不止一个条目时有效
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndoSnapshot();

		// 删除之前 yank 的文本（旋转前仍在 ring 末尾）
		this.deleteYankedText();

		// 旋转 ring：把末尾移到开头
		this.killRing.rotate();

		// 插入新的最近条目（旋转后现在位于末尾）
		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * 在光标位置插入文本（由 yank 操作使用）。
	 */
	private insertYankedText(text: string): void {
		this.exitHistoryBrowsing();
		const lines = text.split("\n");

		if (lines.length === 1) {
			// 单行——在光标处插入
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + text + after;
			this.setCursorCol(this.state.cursorCol + text.length);
		} else {
			// 多行插入
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);

			// 第一行与光标前的文本合并
			this.state.lines[this.state.cursorLine] = before + (lines[0] || "");

			// 插入中间各行
			for (let i = 1; i < lines.length - 1; i++) {
				this.state.lines.splice(this.state.cursorLine + i, 0, lines[i] || "");
			}

			// 最后一行与光标后的文本合并
			const lastLineIndex = this.state.cursorLine + lines.length - 1;
			this.state.lines.splice(lastLineIndex, 0, (lines[lines.length - 1] || "") + after);

			// 更新光标位置
			this.state.cursorLine = lastLineIndex;
			this.setCursorCol((lines[lines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 删除之前 yank 的文本（由 yank-pop 使用）。
	 * 被 yank 的文本取自 killRing[end]，因为它尚未被旋转。
	 */
	private deleteYankedText(): void {
		const yankedText = this.killRing.peek();
		if (!yankedText) return;

		const yankLines = yankedText.split("\n");

		if (yankLines.length === 1) {
			// 单行——从光标处向后删除
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const deleteLen = yankedText.length;
			const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - deleteLen);
		} else {
			// 多行删除——光标位于最后被 yank 行的末尾
			const startLine = this.state.cursorLine - (yankLines.length - 1);
			const startCol = (this.state.lines[startLine] || "").length - (yankLines[0] || "").length;

			// 取当前行中光标之后的文本
			const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(this.state.cursorCol);

			// 取 yank 起始位置之前的文本
			const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);

			// 移除从 startLine 到 cursorLine 的所有行，替换为合并后的一行
			this.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);

			// 更新光标
			this.state.cursorLine = startLine;
			this.setCursorCol(startCol);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private pushUndoSnapshot(): void {
		this.undoStack.push({ state: this.state, pastes: this.pastes, pasteCounter: this.pasteCounter });
	}

	private undo(): void {
		this.exitHistoryBrowsing();
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		Object.assign(this.state, snapshot.state);
		this.pastes = snapshot.pastes;
		this.pasteCounter = snapshot.pasteCounter;
		this.lastAction = null;
		this.preferredVisualCol = null;
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 跳转到指定方向上第一个出现的字符。
	 * 跨行搜索。区分大小写。跳过当前光标位置。
	 */
	private jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.lastAction = null;
		const isForward = direction === "forward";
		const lines = this.state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.state.cursorLine;

			// 当前行：从光标之后/之前开始搜索；其他行：搜索整行
			const searchFrom = isCurrentLine
				? isForward
					? this.state.cursorCol + 1
					: this.state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.state.cursorLine = lineIdx;
				this.setCursorCol(idx);
				return;
			}
		}
		// 未找到匹配——光标保持原位
	}

	private moveWordForwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// 若在行尾，移动到下一行的开头
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine++;
				this.setCursorCol(0);
			}
			return;
		}

		this.setCursorCol(
			findWordForward(currentLine, this.state.cursorCol, {
				segment: (text) => this.segment(text, "word"),
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	// slash 菜单只允许在 editor 的第一行使用
	private isSlashMenuAllowed(): boolean {
		return this.state.cursorLine === 0;
	}

	// 检查光标是否位于消息开头（用于检测斜杠命令）。
	private isAtStartOfMessage(): boolean {
		if (!this.isSlashMenuAllowed()) return false;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	private isInSlashCommandContext(textBeforeCursor: string): boolean {
		return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
	}

	// 自动补全方法
	/**
	 * 为给定 prefix 找到最佳匹配的自动补全条目索引。
	 * 未找到匹配时返回 -1。
	 *
	 * 匹配优先级：
	 * 1. 完全匹配（prefix === item.value）—— 总是被选中
	 * 2. 前缀匹配 —— 第一个以 prefix 开头的 item
	 * 3. 无匹配 —— -1（保持默认高亮）
	 *
	 * 匹配区分大小写，且只检查 item.value。
	 */
	private getBestAutocompleteMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
		if (!prefix) return -1;

		let firstPrefixIndex = -1;

		for (let i = 0; i < items.length; i++) {
			const value = items[i]!.value;
			if (value === prefix) {
				return i; // 完全匹配总是优先
			}
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				firstPrefixIndex = i;
			}
		}

		return firstPrefixIndex;
	}

	private createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		const list = new SelectList(items, this.autocompleteMaxVisible, this.theme.selectList, layout);
		list.onSelect = (selected) => {
			if (!this.autocompleteProvider) return;
			this.pushUndoSnapshot();
			this.lastAction = null;
			const result = this.autocompleteProvider.applyCompletion(
				this.state.lines,
				this.state.cursorLine,
				this.state.cursorCol,
				selected,
				this.autocompletePrefix,
			);
			this.state.lines = result.lines;
			this.state.cursorLine = result.cursorLine;
			this.setCursorCol(result.cursorCol);
			this.cancelAutocomplete();
			this.onChange?.(this.getText());
		};
		return list;
	}

	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: false, explicitTab });
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete(true);
		}
	}

	private handleSlashCommandCompletion(): void {
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	private forceFileAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: true, explicitTab });
	}

	private requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void {
		if (!this.autocompleteProvider) return;

		if (options.force) {
			const shouldTrigger =
				!this.autocompleteProvider.shouldTriggerFileCompletion ||
				this.autocompleteProvider.shouldTriggerFileCompletion(
					this.state.lines,
					this.state.cursorLine,
					this.state.cursorCol,
				);
			if (!shouldTrigger) {
				return;
			}
		}

		this.cancelAutocompleteRequest();
		const startToken = ++this.autocompleteStartToken;

		const debounceMs = this.getAutocompleteDebounceMs(options);
		if (debounceMs > 0) {
			this.autocompleteDebounceTimer = setTimeout(() => {
				this.autocompleteDebounceTimer = undefined;
				void this.startAutocompleteRequest(startToken, options);
			}, debounceMs);
			return;
		}

		void this.startAutocompleteRequest(startToken, options);
	}

	private async startAutocompleteRequest(
		startToken: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		const previousTask = this.autocompleteRequestTask;
		this.autocompleteRequestTask = (async () => {
			await previousTask;
			if (startToken !== this.autocompleteStartToken || !this.autocompleteProvider) {
				return;
			}

			const controller = new AbortController();
			this.autocompleteAbort = controller;
			const requestId = ++this.autocompleteRequestId;
			const snapshotText = this.getText();
			const snapshotLine = this.state.cursorLine;
			const snapshotCol = this.state.cursorCol;

			await this.runAutocompleteRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
		})();
		await this.autocompleteRequestTask;
	}

	private setAutocompleteTriggerCharacters(triggerCharacters: string[]): void {
		const next = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
		for (const character of triggerCharacters) {
			if (character.length !== 1 || character === "/" || isWhitespaceChar(character) || next.includes(character)) {
				continue;
			}
			next.push(character);
		}
		this.autocompleteTriggerCharacters = next;
		this.autocompleteTriggerPattern = buildTriggerPattern(next);
		this.autocompleteDebouncePattern = buildDebouncePattern(next);
	}

	private getAutocompleteDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		return this.autocompleteDebouncePattern.test(textBeforeCursor) ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	private async runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		if (!this.autocompleteProvider) return;

		const suggestions = await this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
			{ signal: controller.signal, force: options.force },
		);

		if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			return;
		}

		this.autocompleteAbort = undefined;

		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			this.cancelAutocomplete();
			this.tui.requestRender();
			return;
		}

		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			const item = suggestions.items[0]!;
			this.pushUndoSnapshot();
			this.lastAction = null;
			const result = this.autocompleteProvider.applyCompletion(
				this.state.lines,
				this.state.cursorLine,
				this.state.cursorCol,
				item,
				suggestions.prefix,
			);
			this.state.lines = result.lines;
			this.state.cursorLine = result.cursorLine;
			this.setCursorCol(result.cursorCol);
			if (this.onChange) this.onChange(this.getText());
			this.tui.requestRender();
			return;
		}

		this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		this.tui.requestRender();
	}

	private isAutocompleteRequestCurrent(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
	): boolean {
		return (
			!controller.signal.aborted &&
			requestId === this.autocompleteRequestId &&
			this.getText() === snapshotText &&
			this.state.cursorLine === snapshotLine &&
			this.state.cursorCol === snapshotCol
		);
	}

	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
	}

	private cancelAutocompleteRequest(): void {
		this.autocompleteStartToken += 1;
		if (this.autocompleteDebounceTimer) {
			clearTimeout(this.autocompleteDebounceTimer);
			this.autocompleteDebounceTimer = undefined;
		}
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
	}

	private clearAutocompleteUi(): void {
		this.autocompleteState = null;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
	}

	private cancelAutocomplete(): void {
		this.cancelAutocompleteRequest();
		this.clearAutocompleteUi();
	}

	public isShowingAutocomplete(): boolean {
		return this.autocompleteState !== null;
	}

	private updateAutocomplete(): void {
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}
}
