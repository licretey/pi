// TUI 核心接口与类。

export { Marked, type Token, type Tokens } from "marked";
// 自动补全支持。
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.ts";
// 颜色与样式。
export {
	backgroundAnsi,
	type Color,
	type ColorMixSpace,
	colorToHex,
	colorToOkhsl,
	colorToOklch,
	colorToRgb,
	foregroundAnsi,
	type IndexedColor,
	indexedColor,
	mixColors,
	type OkhslChannels,
	type OklchChannels,
	type OklchColorValue,
	okhslColor,
	oklchColor,
	parseColor,
	type RgbColorValue,
	rgbColor,
	styleText,
	styleTextWithAnsi,
	type TerminalColorMode,
	type TextAttributes,
	type TextStyle,
} from "./colors.ts";
// 组件。
export { Box } from "./components/box.ts";
export { CancellableLoader } from "./components/cancellable-loader.ts";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.ts";
export { HStack } from "./components/h-stack.ts";
export {
	Image,
	type ImageOptions,
	type ImageTheme,
	type ImageTranscoder,
	setImageTranscoder,
} from "./components/image.ts";
export { Input } from "./components/input.ts";
export { Loader, type LoaderIndicatorOptions } from "./components/loader.ts";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "./components/markdown.ts";
export { MouseRegion, type MouseRegionHandler } from "./components/mouse-region.ts";
export {
	ScrollView,
	type ScrollViewOptions,
	type ScrollViewScrollbar,
	type ScrollViewScrollToOptions,
} from "./components/scroll-view.ts";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./components/select-list.ts";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.ts";
export { Spacer } from "./components/spacer.ts";
export { Text } from "./components/text.ts";
export { TruncatedText } from "./components/truncated-text.ts";
export {
	type StackChild,
	type StackEntry,
	type StackEntryOptions,
	type StackOptions,
	VStack,
} from "./components/v-stack.ts";
// 编辑器组件接口（用于自定义编辑器）。
export type { EditorComponent } from "./editor-component.ts";
// 模糊匹配。
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";
// 按键绑定。
export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.ts";
// 键盘输入处理。
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.ts";
// LaTeX 渲染。
export { type RenderLatexOptions, renderLatex } from "./latex.ts";
// 原生平台集成。
export { getNativeClipboard, type NativeClipboard } from "./native-platform.ts";
export { oklabToOkhslLightness } from "./oklab.ts";
// 程序状态报告（OSC 7501）。
export { formatProgramStatus, type ProgramStatus } from "./program-status.ts";
// 用于拆分输入批次的缓冲区。
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.ts";
// 终端接口与实现。
export { isAppleTerminalSession, ProcessTerminal, type Terminal } from "./terminal.ts";
// 终端颜色。
export {
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
	type TerminalColors,
} from "./terminal-colors.ts";
// 终端图片支持。
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getTerminalColorMode,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.ts";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	compositeTuiLine,
	type Focusable,
	isFocusable,
	isViewportTUI,
	type OverlayAnchor,
	type OverlayBounds,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	renderFakeCursor,
	type SizeValue,
	type TUI,
	type TuiInputListener,
	type TuiInputListenerResult,
	type TuiMode,
	type TuiMouseButton,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type TuiMouseEventType,
	type TuiStopOptions,
	type ViewportTUI,
} from "./tui.ts";
export { TuiAltScreen, type TuiAltScreenOptions } from "./tui-alt-screen.ts";
export { TuiMainScreen, type TuiMainScreenRenderState } from "./tui-main-screen.ts";
// 工具函数。
export {
	getOsc8LinkAtColumn,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "./utils.ts";
export type { WheelScrollLines } from "./wheel-scroll.ts";
