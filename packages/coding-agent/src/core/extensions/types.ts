/**
 * Extension 系统类型。
 *
 * Extension 是 TypeScript 模块，可以：
 * - 订阅 agent 生命周期事件
 * - 注册 LLM 可调用的 tool
 * - 注册 command、快捷键和 CLI flag
 * - 通过 UI 原语与用户交互
 */

import type {
	AgentMessage,
	AgentTool,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
	AnyModel,
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ClassifierApi,
	ConstrainedSamplingConfig,
	ImageApi,
	ImageContent,
	JsonValue,
	Message,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	Provider,
	ProviderClassifier,
	ProviderHeaders,
	ProviderId,
	ProviderImages,
	RefreshModelsContext,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	Component,
	EditorComponent,
	EditorTheme,
	KeyId,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { BashResult } from "../bash-executor.ts";
import type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "../cache-warmer.ts";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.ts";
import type { EventBus } from "../event-bus.ts";
import type { ExecOptions, ExecResult } from "../exec.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { McpServerConfig, McpServerRegistry, RegisteredMcpServer } from "../mcp-servers.ts";
import type { CustomMessage } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ContextEditEntry,
	CustomEntry,
	ProjectedSessionEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionManager,
} from "../session-manager.ts";
import type { Settings } from "../settings-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import type { SourceInfo } from "../source-info.ts";
import type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { EditToolDetails } from "../tools/edit.ts";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolInput,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	PowerShellToolDetails,
	PowerShellToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../tools/index.ts";
import type { ModelRoute, ModelRouteRequest, VirtualModelDefinition } from "../virtual-models.ts";

export type { ExecOptions, ExecResult } from "../exec.ts";
export type { BuildSystemPromptOptions, NormalizedBuildSystemPromptOptions } from "../system-prompt.ts";
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";

// ============================================================================
// UI 上下文
// ============================================================================

/** extension UI 对话框的选项。 */
export interface ExtensionUIDialogOptions {
	/** 用于程序化关闭对话框的 AbortSignal。 */
	signal?: AbortSignal;
	/** 超时毫秒数。对话框自动关闭，并显示实时倒计时。 */
	timeout?: number;
}

/** extension widget 的摆放位置。 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** extension widget 的选项。 */
export interface ExtensionWidgetOptions {
	/** widget 渲染的位置。默认为 "aboveEditor"。 */
	placement?: WidgetPlacement;
}

/** 供 extension 使用的裸终端输入监听器。 */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** 交互式 streaming loader 的工作指示器配置。 */
export interface WorkingIndicatorOptions {
	/** 动画帧。传空数组可完全隐藏指示器。自定义帧会原样渲染。 */
	frames?: string[];
	/** 动画指示器的帧间隔毫秒数。 */
	intervalMs?: number;
}

/** 在当前 autocomplete provider 外再包一层附加行为。 */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

/**
 * 供 extension 请求交互式 UI 的 context。
 * 每种模式（interactive、RPC、print）各自提供实现。
 */
export interface ExtensionUIContext {
	/** 显示选择器并返回用户的选择。 */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 显示确认对话框。 */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** 显示文本输入对话框。 */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 向用户显示通知。 */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** 监听裸终端输入（仅 interactive 模式）。返回取消订阅函数。 */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** 在 footer/status bar 中设置状态文本。传 undefined 清除。 */
	setStatus(key: string, text: string | undefined): void;

	/** 设置 streaming 期间显示的 working/loading 消息。无参调用恢复默认。 */
	setWorkingMessage(message?: string): void;

	/** 在 streaming 期间显示或隐藏内置的交互式 working loader 行。 */
	setWorkingVisible(visible: boolean): void;

	/**
	 * 配置 streaming 期间显示的交互式 working 指示器。
	 *
	 * - 不传参数恢复默认动画 spinner。
	 * - 传 `frames: ["●"]` 得到静态指示器。
	 * - 传 `frames: []` 完全隐藏指示器。
	 * - 自定义帧原样渲染，extension 需自行添加颜色。
	 */
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** 设置隐藏 thinking 块显示的标签。无参调用恢复默认。 */
	setHiddenThinkingLabel(label?: string): void;

	/** 设置显示在编辑器上方或下方的 widget。接受字符串数组或组件工厂。 */
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	/** 设置自定义 footer 组件，传 undefined 恢复内置 footer。
	 *
	 * 工厂会收到一个 FooterDataProvider，提供其他途径拿不到的数据：
	 * git branch 以及 setStatus() 设置的 extension 状态。Context 用量在
	 * ctx.getContextUsage()，token 统计在 ctx.sessionManager.getEntries()，model 信息在 ctx.model。
	 */
	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	/** 设置自定义 header 组件（启动时显示在聊天区上方），传 undefined 恢复内置 header。 */
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** 设置终端窗口/标签页标题。 */
	setTitle(title: string): void;

	/** 显示一个持有键盘焦点的自定义组件。 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			/** overlay 的定位/尺寸选项。可以是静态值，也可以是用于动态更新的函数。 */
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** overlay 显示后以 overlay handle 调用。用于控制可见性。 */
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T>;

	/** 把文本粘贴进编辑器，触发粘贴处理（大内容会折叠）。 */
	pasteToEditor(text: string): void;

	/** 设置核心输入编辑器中的文本。 */
	setEditorText(text: string): void;

	/** 获取核心输入编辑器中的当前文本。 */
	getEditorText(): string;

	/** 显示一个多行编辑器用于编辑文本。 */
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/** 在内置 provider 之上叠加额外的 autocomplete 行为。 */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/**
	 * 通过工厂函数设置自定义编辑器组件。
	 * 传 undefined 恢复默认编辑器。
	 *
	 * 工厂会收到：
	 * - `theme`：用于边框和 autocomplete 样式的 EditorTheme
	 * - `keybindings`：应用级快捷键的 KeybindingsManager
	 *
	 * 要支持完整的应用级快捷键（escape、ctrl+d、切换 model 等），
	 * 请继承 `@earendil-works/pi-coding-agent` 的 `CustomEditor`，
	 * 并对你不处理的按键调用 `super.handleInput(data)`。
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@earendil-works/pi-coding-agent";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // 处理 Vim 普通模式按键……
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // 应用快捷键和文本编辑
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	setEditorComponent(factory: EditorFactory | undefined): void;

	/** 获取当前配置的自定义编辑器工厂，使用默认编辑器时为 undefined。 */
	getEditorComponent(): EditorFactory | undefined;

	/** 获取用于样式定制的当前主题。 */
	readonly theme: Theme;

	/** 获取所有可用主题及其名称和文件路径。 */
	getAllThemes(): { name: string; path: string | undefined }[];

	/** 按名称加载主题但不切换。未找到返回 undefined。 */
	getTheme(name: string): Theme | undefined;

	/** 按名称或 Theme 对象设置当前主题。 */
	setTheme(theme: string | Theme): { success: boolean; error?: string };

	/** 获取当前 tool 输出展开状态。 */
	getToolsExpanded(): boolean;

	/** 设置 tool 输出展开状态。 */
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// Extension Context（extension 上下文相关类型）
// ============================================================================

export interface ContextUsage {
	/** 估算的 context tokens；未知时为 null（如 compaction 刚结束、下一次 LLM 响应之前）。 */
	tokens: number | null;
	contextWindow: number;
	/** context 用量占 context window 的百分比；tokens 未知时为 null。 */
	percent: number | null;
}

export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * 传给 extension 事件处理器的 context。
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionContext {
	/** 供用户交互的 UI 方法 */
	ui: ExtensionUIContext;
	/** 当前运行模式。用 "tui" 来守护仅限终端的 UI，如自定义组件。 */
	mode: ExtensionMode;
	/** 是否有支持对话框的 UI 可用（TUI 和 RPC 模式为 true） */
	hasUI: boolean;
	/** 当前工作目录 */
	cwd: string;
	/** session manager（只读） */
	sessionManager: ReadonlySessionManager;
	/** 用于 API key 解析的 model 注册表 */
	modelRegistry: ModelRegistry;
	/** 当前 model（可能为 undefined） */
	model: Model<any> | undefined;
	/** 本会话限定的 models（由 `--models` /
	 *  `enabledModels` 设置对照可用目录解析而来）。与
	 *  `/scoped-models` 命令显示的集合相同。未配置限定时为空
	 *  （所有可用模型均可使用）。只读快照。 */
	scopedModels: readonly ScopedModel[];
	/** 当前 thinking level（由 session runtime 提供时）。 */
	thinkingLevel?: ThinkingLevel;
	/** agent 是否空闲（未在 streaming） */
	isIdle(): boolean;
	/** 此 context 是否启用了 project 本地信任。 */
	isProjectTrusted(): boolean;
	/** 当前 abort signal；agent 未在 streaming 时为 undefined。 */
	signal: AbortSignal | undefined;
	/** 中止当前的 agent 操作 */
	abort(): void;
	/** 是否有排队中的消息在等待 */
	hasPendingMessages(): boolean;
	/** 优雅关闭 pi 并退出。所有 context 均可用。 */
	shutdown(): void;
	/** 获取活动 model 当前的 context 用量。 */
	getContextUsage(): ContextUsage | undefined;
	/** 触发 compaction，不等待其完成。 */
	compact(options?: CompactOptions): void;
	/** 获取当前生效的 system prompt。 */
	getSystemPrompt(): string;
}

/** {@link ExtensionToolContext.executeTool} 的选项。 */
export interface ExecuteToolOptions {
	/** 默认为调用方 tool 的 signal。 */
	signal?: AbortSignal;
	/** 除 `tool_execution_update` 事件外，还会接收嵌套 tool 的部分结果。 */
	onUpdate?: AgentToolUpdateCallback;
}

/**
 * 会话中传给 tool `execute()` 的 context：即 extension context，外加 `executeTool()`——
 * 它运行其他 tool 时会经过与模型发起的调用相同的校验、hooks 和权限检查。
 *
 * 用 `wrapToolDefinition()` 包装且未提供 context 工厂的 tool——比如
 * `createBashTool()` 创建的内置 tool，运行在普通 `Agent` 中或被直接调用——拿不到 context。
 */
export interface ExtensionToolContext extends ExtensionContext {
	/** {@link executeTool} 可调用的 tools。 */
	readonly tools: readonly AgentTool[];
	/**
	 * 运行另一个 tool。该调用会获得 `<calling id>/<n>` 这样的 id，
	 * 且 `tool_call`、`tool_result`、`tool_execution_*` 事件会带上 `parentToolCallId`。
	 * 它不会出现在 transcript 中；调用方 tool 的结果消息上会以 `nestedCalls`
	 * 保留一份有上限的记录。
	 *
	 * tool 失败时绝不 reject：未知 tool、校验错误、被阻止的调用和抛出的
	 * 错误都将以 `isError: true` 返回。
	 */
	executeTool(name: string, args: unknown, options?: ExecuteToolOptions): Promise<AgentToolCallOutcome>;
}

/**
 * command 处理器的扩展 context。
 * 包含仅在用户主动触发的 command 中才安全的会话控制方法。
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/** 获取当前的基础 system-prompt 构建选项。 */
	getSystemPromptOptions(): BuildSystemPromptOptions;

	/** 等待 agent 完成 streaming */
	waitForIdle(): Promise<void>;

	/** 开始新会话，可选地执行初始化。 */
	newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** 从指定 entry 分叉，创建新的 session 文件。 */
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** 导航到 session tree 的另一个节点。 */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	/** 切换到另一个 session 文件。 */
	switchSession(
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** 重新加载 extensions、skills、prompts、themes 和 context 文件。 */
	reload(): Promise<void>;
}

/**
 * session 切换后绑定到替换会话的全新 command-capable context。
 *
 * 它会传给 `newSession()`、`fork()` 和 `switchSession()` 的 `withSession()` 回调。
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;
}

// ============================================================================
// Tool 类型
// ============================================================================

/** tool 结果的渲染选项 */
export interface ToolRenderResultOptions {
	/** 结果视图是否展开 */
	expanded: boolean;
	/** 是否为部分/流式结果 */
	isPartial: boolean;
}

/** 传给 tool 渲染器的 context。 */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** 当前 tool call 参数。同一 tool call 的 call/result 渲染之间共享。 */
	args: TArgs;
	/** 本次 tool 执行的唯一 id。同一 tool call 的 call/result 渲染之间保持稳定。 */
	toolCallId: string;
	/** 仅让这一个 tool 执行组件失效以便重绘。 */
	invalidate: () => void;
	/** 此渲染槽位上一次返回的组件（如有）。 */
	lastComponent: Component | undefined;
	/** 此 tool 行的共享渲染器状态。由 tool-execution.ts 初始化。 */
	state: TState;
	/** 本次 tool 执行的工作目录。 */
	cwd: string;
	/** tool 执行是否已开始。 */
	executionStarted: boolean;
	/** tool call 参数是否已完整。 */
	argsComplete: boolean;
	/** tool 结果是否为部分/流式。 */
	isPartial: boolean;
	/** 结果视图是否展开。 */
	expanded: boolean;
	/** TUI 当前是否显示内联图片。 */
	showImages: boolean;
	/** 当前结果是否为错误。 */
	isError: boolean;
	/**
	 * tool 执行耗时的毫秒数，取自最终结果；运行中、未运行或
	 * 记录时长机制之前保存的结果均为 `undefined`。
	 */
	durationMs: number | undefined;
	/** outputPad 设置配置的水平内边距。`renderShell: "self"` 的渲染器自行应用。 */
	outputPad: number;
}

/**
 * model 如何触达一个 tool。"Callable" 指可以通过 `ctx.executeTool()`
 * 被其他 tool 调用，就像 `codemode` tool 那样。
 *
 * - `direct`：活跃时声明给 model，且活跃时可被调用。
 * - `model-only`：活跃时声明给 model，永不可调用。用于编排型或交互型 tool。
 * - `codemode`：注册后即可被调用。除非显式激活，否则不声明给 model。
 *   Codemode tools 会在自己的描述里列出它。
 * - `deferred`：类似 `codemode`，但 codemode tools 不列出它；tool search 能找到它。
 * - `hidden`：已注册但不可触达。激活它没有效果。
 *
 * `direct` 和 `model-only` tools 在注册时即被激活；其余不会。
 * 活跃 tool 集合（`getActiveTools`/`setActiveTools`）就是声明给 model 的集合。
 */
export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

/**
 * 关于 tool 用途的提示，语义等同 MCP tool annotations。它们来自 tool
 * 作者且未经校验；permission extension 可借其决定哪些调用需要确认。
 */
export interface ToolAnnotations {
	/** 该 tool 不修改其环境。 */
	readOnlyHint?: boolean;
	/** 该 tool 可能删除或覆盖数据，而不只是追加。非 read-only 时有意义。 */
	destructiveHint?: boolean;
	/** 以相同参数重复调用不会再产生额外效果。非 read-only 时有意义。 */
	idempotentHint?: boolean;
	/** 该 tool 会触达开放的外部实体（如 web），而非封闭领域。 */
	openWorldHint?: boolean;
}

/** 一组相关 tool，例如同一个 MCP server 的 tools。Codemode tools 会把它们一起列出。 */
export interface ToolNamespace {
	/** 例如 `mcp__docs`。 */
	name: string;
	/** 在面向 model 的 tool 列表里与该组一起展示的简短摘要。 */
	description?: string;
	/**
	 * 更长的使用说明，例如 MCP server instructions。不属于 tool 列表；按请求
	 * 描述该 namespace 的 tool（codemode 的 `describeNamespace()`）会返回它。
	 */
	instructions?: string;
}

/** {@link ToolDefinition.prepareLoadout} 眼中一个会话的 tools。 */
export interface ToolLoadout {
	/** 声明给 model 的 tools（即活跃 tools），按序排列，保留其原始描述。 */
	readonly declared: readonly AgentTool[];
	/** 可通过 `ctx.executeTool()` 调用的 tools。 */
	readonly callable: readonly AgentTool[];
	/** 每一个已注册的 tool。 */
	readonly registered: readonly AgentTool[];
	getExposure(name: string): ToolExposure;
	getNamespace(name: string): ToolNamespace | undefined;
	/** tool 的 `promptGuidelines`。隐藏声明会把它们从 system prompt 中去掉。 */
	getPromptGuidelines(name: string): readonly string[];
}

/** {@link ToolDefinition.prepareLoadout} 对 model 可见内容所做的更改。 */
export interface ToolLoadoutChanges {
	/** 已声明 tools 面向 model 的描述，按 tool 名索引。 */
	descriptions?: Readonly<Record<string, string>>;
	/**
	 * 请求会省去其声明的已声明 tools。它们保持活跃且可调用，且
	 * transcript 仍会声明它们，因此活跃集合在 `/tree` 和 resume 之后依然成立。
	 */
	hiddenDeclarations?: readonly string[];
}

/**
 * registerTool() 用的 tool 定义。
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	/** tool 名称（用于 LLM tool call） */
	name: string;
	/** UI 使用的人类可读标签 */
	label: string;
	/** 给 LLM 的描述 */
	description: string;
	/** 可选的一行简介，用于默认 system prompt 的 Available tools 部分。未提供时自定义 tool 不会出现在该部分。 */
	promptSnippet?: string;
	/** 可选的 guideline 条目，本 tool 活跃时追加到默认 system prompt 的 Guidelines 部分。 */
	promptGuidelines?: string[];
	/** 参数 schema（TypeBox） */
	parameters: TParams;
	/** 本 tool 可选的 provider 侧 constrained sampling 请求。设为 false 显式禁用，与留 undefined 等价。 */
	constrainedSampling?: false | ConstrainedSamplingConfig;
	/** 控制 ToolExecutionComponent 渲染标准彩色外壳，还是由 tool 自行渲染边框。 */
	renderShell?: "default" | "self";

	/** 可选的兼容垫层，在 schema 校验前预处理原始 tool call 参数。必须返回符合 TParams 的对象。 */
	prepareArguments?: (args: unknown) => Static<TParams>;

	/**
	 * 成功结果中 `structuredContent` 的 JSON Schema。声明了它的 tool 应始终
	 * 设置 `structuredContent`；codemode 脚本将收到它而非文本内容。
	 */
	outputSchema?: TSchema;

	/**
	 * model 如何触达该 tool。默认：`"direct"`。见 {@link ToolExposure}。
	 */
	exposure?: ToolExposure;

	/** tool 所属的组，例如其 MCP server。 */
	namespace?: ToolNamespace;

	/** 关于 tool 用途的提示，例如来自 MCP server。 */
	annotations?: ToolAnnotations;

	/**
	 * 注册该 tool 时是否同时激活它。默认：`direct` 和 `model-only` tools 为 `true`；
	 * 其余 exposure 在注册时从不激活。`defaultActive: false` 的 tool 通过在
	 * `--tools` 或 `defaultTools` 设置中点名，或用 `setActiveTools()` 来激活。
	 */
	defaultActive?: boolean;

	/**
	 * 本 tool 活跃时，调整 loadout 呈现给 model 的方式。活跃 tools
	 * 每次变化都会调用。编排其他 tools 的 tool 用它来做例如在自己
	 * 描述中列出可调用的 tools。
	 */
	prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;

	/**
	 * 每个 tool 的执行模式覆盖。
	 * - "sequential"：该 tool 必须与其他 tool call 逐个执行。
	 * - "parallel"：该 tool 可与其他 tool call 并发执行。
	 *
	 * 省略时应用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;

	/** 执行该 tool。 */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionToolContext,
	): Promise<AgentToolResult<TDetails>>;

	/** tool call 展示的自定义渲染 */
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	/** tool result 展示的自定义渲染 */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

export type ToolRenderers = Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult">;

/**
 * 决定一个 tool 的调用如何绘制，包括未注册的 tools。`next()` 返回
 * 其余 resolver、随后是已注册 tool 会使用的渲染器。
 */
export type ToolRendererResolver = (
	toolName: string,
	next: () => ToolRenderers | undefined,
) => ToolRenderers | undefined;

/**
 * 为独立 tool 定义保留参数类型推断。
 *
 * 把 tool 赋值给变量或传入 `customTools` 之类数组时使用它，
 * 否则上下文类型推断会把 params 放宽为 `unknown`。
 */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

// ============================================================================
// 启动/资源事件
// ============================================================================

export interface ProjectTrustEvent {
	type: "project_trust";
	cwd: string;
}

export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

export interface ProjectTrustEventResult {
	trusted: ProjectTrustEventDecision;
	remember?: boolean;
}

export interface ProjectTrustContext {
	cwd: string;
	mode: ExtensionMode;
	hasUI: boolean;
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

export type ProjectTrustHandler = (
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

/** 在 session_start 之后触发，允许 extension 提供额外的资源路径。 */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** resources_discover 事件处理器的结果 */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

/**
 * 在 extensions 绑定之后，extension 注册或注销 MCP server 时触发
 * （见 {@link ExtensionAPI.registerMcpServer}）。extensions 加载期间注册的
 * server 在 `session_start` 时用 `pi.getMcpServers()` 读取。处理此事件会把
 * 该 extension 标记为连接已注册 server 的那一个。
 */
export interface McpServersChangeEvent {
	type: "mcp_servers_change";
	/** 变更后所有已注册的 server。 */
	servers: RegisteredMcpServer[];
}

// ============================================================================
// 会话事件
// ============================================================================

/** 会话启动、加载或重新加载时触发 */
export interface SessionStartEvent {
	type: "session_start";
	/** 本次会话启动的原因。 */
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** 之前活跃的 session 文件。"new"、"resume" 和 "fork" 时存在。 */
	previousSessionFile?: string;
}

/** 当前会话元数据变更时触发。 */
export interface SessionInfoChangedEvent {
	type: "session_info_changed";
	/** 当前规范化后的会话名称。清除名称时为 undefined。 */
	name: string | undefined;
}

/** 切换到另一个会话之前触发（可取消） */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

/** 分叉会话之前触发（可取消） */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

/** context compaction 之前触发（可取消或自定义） */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	/** compaction 的触发原因：手动 /compact、context 阈值，或 context 溢出恢复 */
	reason: "manual" | "threshold" | "overflow";
	/** 为 true 时，被中止的 turn 会在本次 compaction 后重试（溢出恢复） */
	willRetry: boolean;
	signal: AbortSignal;
}

/** context compaction 成功后触发 */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
	/** compaction 的触发原因：手动 /compact、context 阈值，或 context 溢出恢复 */
	reason: "manual" | "threshold" | "overflow";
	/** 为 true 时，被中止的 turn 会在本次 compaction 后重试（溢出恢复） */
	willRetry: boolean;
}

/** context compaction 失败或被中止后触发 */
export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	/** compaction 的触发原因：手动 /compact、context 阈值，或 context 溢出恢复 */
	reason: "manual" | "threshold" | "overflow";
	/** compaction 因非中止原因失败时的错误文本。 */
	errorMessage?: string;
	/** compaction 被取消或中止时为 true。 */
	aborted: boolean;
	/** 被中止的 turn 原本会在本次 compaction 后重试时为 true（溢出恢复） */
	willRetry: boolean;
	/** 失败的 compaction 内容来自 session_before_compact 处理器时为 true。 */
	fromExtension: boolean;
}

/** 因退出、重载或会话替换而即将拆除 extension runtime 之前触发。 */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	/** 因会话替换而关闭时的目标 session 文件。 */
	targetSessionFile?: string;
}

/** tree 导航的准备数据 */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	/** 摘要用的自定义指令 */
	customInstructions?: string;
	/** 为 true 时，customInstructions 替换默认 prompt 而不是追加在其后 */
	replaceInstructions?: boolean;
	/** 附加到 branch summary 条目的标签 */
	label?: string;
}

/** 在 session tree 中导航之前触发（可取消） */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** 在 session tree 中导航之后触发 */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionInfoChangedEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

// ============================================================================
// Agent 事件
// ============================================================================

/**
 * 每次 LLM 调用前触发。可以修改 messages。
 *
 * `messages` 里是不含 system 消息的对话。prompt 和 tool state 归 Pi 所有：
 * 处理器返回后 Pi 会恢复它们，因此处理器既不能丢弃它们，也无需保存它们。
 */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/**
 * 每次 LLM 调用前触发，此时所有 `context` 处理器已运行完毕、Pi 已恢复
 * prompt 和 tool state。`messages` 是包含 system 消息的完整 transcript，
 * 结果会按返回原样发送：处理器拥有 prompt 和 tool 声明的决定权。
 */
export interface ContextWithSystemEvent {
	type: "context_with_system";
	messages: AgentMessage[];
}

/** provider 请求发出前触发。可以替换 payload。 */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/**
 * 请求头组装完成后、provider HTTP 调用之前触发。
 * 处理器就地修改 `headers`（例如注入 tracing/session 头）；
 * 返回值被忽略。值为 `null` 会删除该头。
 */
export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers";
	headers: ProviderHeaders;
}

/** 收到 provider 响应之后、消费响应流之前触发。 */
export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

/** provider 流事件解析后、Pi 规范化之前触发。 */
export interface ProviderStreamEvent {
	type: "provider_stream_event";
	provider: ProviderId;
	api: Api;
	model: string;
	data: unknown;
}

/** 用户提交 prompt 之后、agent loop 启动之前触发。 */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	/** 用户 prompt 原始文本（展开之后）。 */
	prompt: string;
	/** 附着在用户 prompt 上的图片（如有）。 */
	images?: ImageContent[];
	/** 当前 system prompt，由 systemPromptOptions 和更早处理器的修改渲染而来。 */
	readonly systemPrompt: string;
	/** 可变的 prompt sections。更后面的处理器能看到更早处理器做的修改。 */
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/** agent loop 启动时触发 */
export interface AgentStartEvent {
	type: "agent_start";
}

/** agent loop 结束时触发 */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

export type AgentActivityOutcome = "completed" | "aborted" | "error";

export interface CustomEntryDraft {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface CustomMessageEntryDraft {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
}

export interface ContextEditEntryDraft {
	type: "context_edit";
	targetId: string;
	replacement: ContextEditEntry["replacement"];
}

export interface CompactionEntryDraft {
	type: "compaction";
	summary: string;
	/** 为 null 时创建一个自保留的 compaction，不保留任何之前的 entries。 */
	firstKeptEntryId: string | null;
	details?: unknown;
	usage?: Usage;
}

export type SessionBoundaryDraft =
	| CustomEntryDraft
	| CustomMessageEntryDraft
	| ContextEditEntryDraft
	| CompactionEntryDraft;

export interface BoundaryContextPreview {
	contextEntries: ProjectedSessionEntry[];
	contextMessages: AgentMessage[];
	llmMessages: Message[];
	pendingMessages: AgentMessage[];
	canContinue: boolean;
}

export interface BoundaryState {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	outcome: AgentActivityOutcome;
}

export interface BoundaryResult {
	entries?: SessionBoundaryDraft[];
	continue?: boolean;
}

/** 最终结算前触发。可以追加 entries 并确保发出一次下一次 provider 请求。 */
export interface AgentBeforeSettleEvent extends BoundaryState {
	type: "agent_before_settle";
}

/** agent 运行完全结算后、且不会再有自动重试、compaction 或排队续跑时触发。 */
export interface AgentSettledEvent {
	type: "agent_settled";
	/** 运行是否因被中止而结束，例如按了 Escape。 */
	aborted: boolean;
}

export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** Pi 开始等待一个面向用户的阻塞性 extension UI 询问时触发。 */
export interface UIPromptStartEvent {
	type: "ui_prompt_start";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

/** Pi 不再等待一个面向用户的阻塞性 extension UI 询问时触发。 */
export interface UIPromptEndEvent {
	type: "ui_prompt_end";
	reason: "ui_prompt";
	kind: UIPromptKind;
	title?: string;
}

/** 每个 turn 开始时触发 */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** 每个 turn 结束时触发 */
export interface TurnEndEvent extends BoundaryState {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
	messageEntryId: string;
	toolResultEntryIds: string[];
}

/** 消息开始时触发（user、assistant 或 toolResult） */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** assistant 消息 streaming 期间随逐 token 更新触发 */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/** 消息结束时触发 */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** tool 开始执行时触发 */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: any;
	/** 由另一个 tool（如 codemode 脚本）发起此调用时设置。 */
	parentToolCallId?: string;
}

/** tool 执行期间随部分/流式输出触发 */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: any;
	partialResult: any;
	/** 由另一个 tool（如 codemode 脚本）发起此调用时设置。 */
	parentToolCallId?: string;
}

/** tool 执行完成时触发 */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: any;
	isError: boolean;
	/** `execute()` 耗费的毫秒数，用单调时钟测量；tool 未运行时缺失。 */
	durationMs?: number;
	/** 由另一个 tool（如 codemode 脚本）发起此调用时设置。 */
	parentToolCallId?: string;
}

// ============================================================================
// Model 事件
// ============================================================================

export type ModelSelectSource = "set" | "cycle" | "restore";

/** 选择了新 model 时触发 */
export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

/** 选择了新 thinking level 时触发 */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

// ============================================================================
// 用户 Bash 事件
// ============================================================================

/** 用户通过 ! 或 !! 前缀执行 bash 命令时触发 */
export interface UserBashEvent {
	type: "user_bash";
	/** 要执行的命令 */
	command: string;
	/** 使用了 !! 前缀时为 true（从 LLM context 排除） */
	excludeFromContext: boolean;
	/** 当前工作目录 */
	cwd: string;
}

// ============================================================================
// 输入事件
// ============================================================================

/** 用户输入的来源 */
export type InputSource = "interactive" | "rpc" | "extension";

/** 用户输入被接收时、agent 处理之前触发 */
export interface InputEvent {
	type: "input";
	/** 输入文本 */
	text: string;
	/** 附着的图片（如有） */
	images?: ImageContent[];
	/** 输入来自哪里 */
	source: InputSource;
	/** streaming 期间输入的投递方式；空闲时为 undefined */
	streamingBehavior?: "steer" | "followUp";
}

/** input 事件处理器的结果 */
export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

// ============================================================================
// Tool 事件
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	/**
	 * 该调用的 id。由另一个 tool 发起的调用（设置了 `parentToolCallId`）会被 pi
	 * 赋予 `<parent id>/<n>`；这类 id 绝不会以 tool call 或 tool result 的形式
	 * 出现在 transcript 中，只出现在父结果的 `nestedCalls` 记录里。
	 */
	toolCallId: string;
	/** 由另一个 tool（如 codemode 脚本）发起此调用时设置。 */
	parentToolCallId?: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface PowerShellToolCallEvent extends ToolCallEventBase {
	toolName: "powershell";
	input: PowerShellToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface LsToolCallEvent extends ToolCallEventBase {
	toolName: "ls";
	input: LsToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * tool 执行前触发。可以阻止。
 *
 * `event.input` 可变。就地修改它，即可在执行前修补 tool 参数。
 * 更晚的 `tool_call` 处理器能看到更早的修改。修改后不会重新校验。
 */
export type ToolCallEvent =
	| BashToolCallEvent
	| PowerShellToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| FindToolCallEvent
	| LsToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	/** 该调用的 id；嵌套调用为 `<parent id>/<n>`，见 `ToolCallEvent`。 */
	toolCallId: string;
	/** 由另一个 tool（如 codemode 脚本）发起此调用时设置。 */
	parentToolCallId?: string;
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	/**
	 * 声明了 `outputSchema` 的 tool 的机器可读结果。redact `content` 的处理器
	 * 也应一并替换此字段；仅替换 `content` 会把它丢掉。
	 */
	structuredContent?: JsonValue;
	isError: boolean;
	/** tool 执行自身产生的 usage（如有）。 */
	usage?: Usage;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

export interface PowerShellToolResultEvent extends ToolResultEventBase {
	toolName: "powershell";
	details: PowerShellToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

export interface LsToolResultEvent extends ToolResultEventBase {
	toolName: "ls";
	details: LsToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** tool 执行之后触发。可以修改结果。 */
export type ToolResultEvent =
	| BashToolResultEvent
	| PowerShellToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| FindToolResultEvent
	| LsToolResultEvent
	| CustomToolResultEvent;

// ToolResultEvent 类型守卫
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}
export function isPowerShellToolResult(e: ToolResultEvent): e is PowerShellToolResultEvent {
	return e.toolName === "powershell";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	return e.toolName === "grep";
}
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	return e.toolName === "find";
}
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	return e.toolName === "ls";
}

/**
 * 按 tool 名收窄 ToolCallEvent 的类型守卫。
 *
 * 内置 tool 自动收窄（无需类型参数）：
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * 自定义 tool 需要显式类型参数：
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * 注意：直接用 `event.toolName === "bash"` 收窄行不通，因为
 * CustomToolCallEvent.toolName 是 `string`，会与所有字面量重叠。
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "powershell", event: ToolCallEvent): event is PowerShellToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/** 所有事件类型的联合 */
export type ExtensionEvent =
	| ProjectTrustEvent
	| ResourcesDiscoverEvent
	| McpServersChangeEvent
	| SessionEvent
	| ContextEvent
	| ContextWithSystemEvent
	| CacheWarmingDecisionEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| AfterProviderResponseEvent
	| ProviderStreamEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentBeforeSettleEvent
	| AgentSettledEvent
	| UIPromptStartEvent
	| UIPromptEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

// ============================================================================
// 事件结果
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type TurnEndEventResult = BoundaryResult;
export type AgentBeforeSettleEventResult = BoundaryResult;

export type BeforeProviderRequestEventResult = unknown;

export type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "../cache-warmer.ts";

export interface ToolCallEventResult {
	/** 阻止 tool 执行。要修改参数，请改为就地修改 `event.input`。 */
	block?: boolean;
	reason?: string;
	/**
	 * 提示 agent 应在本调用被阻止后停止当前 tool 批次。
	 * 只有批次内每个已定稿的 tool result 都设为 true 时才会提前终止。
	 */
	terminate?: boolean;
}

/** user_bash 事件处理器的结果 */
export type UserBashEventResult =
	| {
			/** 用于执行的自定义操作 */
			operations: BashOperations;
			result?: never;
	  }
	| {
			operations?: never;
			/** 完全替换：extension 已处理执行，采用此结果 */
			result: BashResult;
	  };

/**
 * `tool_result` 处理器所做的更改。省略的字段保持原样，但有一个例外：替换
 * `content` 却不返回 `structuredContent` 会把结构化内容丢掉，因为它可能
 * 不再匹配。想保留就把它与 `content` 一起返回。
 */
export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
	usage?: Usage;
}

export interface MessageEndEventResult {
	/** 替换已定稿的消息。替换必须保持原消息的 role。 */
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** 替换本 turn 的完整 system prompt。更后面的处理器看到的就是这个覆盖值。 */
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: unknown;
		usage?: Usage;
	};
	/** 覆盖摘要用的自定义指令 */
	customInstructions?: string;
	/** 覆盖 customInstructions 是否替换默认 prompt */
	replaceInstructions?: boolean;
	/** 覆盖附加到 branch summary 条目的标签 */
	label?: string;
}

// ============================================================================
// Message 与 Entry 渲染
// ============================================================================

export interface MessageRenderOptions {
	expanded: boolean;
	/** outputPad 设置配置的水平内边距。 */
	outputPad: number;
}

export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

export interface EntryRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export type EntryRenderer<T = unknown> = (
	entry: CustomEntry<T>,
	options: EntryRenderOptions,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// Command 注册
// ============================================================================

export interface RegisteredCommand {
	name: string;
	sourceInfo: SourceInfo;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
	invocationName: string;
}

// ============================================================================
// Extension API（扩展 API）
// ============================================================================

/** 事件处理器函数类型 */
// biome-ignore lint/suspicious/noConfusingVoidType: void 允许直接使用 return 语句。
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * 传给 extension 工厂函数的 ExtensionAPI。
 */
export interface ExtensionAPI {
	// =========================================================================
	// 事件订阅
	// =========================================================================

	on(event: "project_trust", handler: ProjectTrustHandler): () => void;
	on(
		event: "resources_discover",
		handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>,
	): () => void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): () => void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): () => void;
	on(
		event: "session_before_fork",
		handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>,
	): () => void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): () => void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): () => void;
	on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): () => void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
	on(event: "mcp_servers_change", handler: ExtensionHandler<McpServersChangeEvent>): () => void;
	on(
		event: "session_before_tree",
		handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>,
	): () => void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): () => void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): () => void;
	on(event: "context_with_system", handler: ExtensionHandler<ContextWithSystemEvent, ContextEventResult>): () => void;
	on(
		event: "cache_warming_decision",
		handler: ExtensionHandler<CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult>,
	): () => void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): () => void;
	on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): () => void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): () => void;
	on(event: "provider_stream_event", handler: ExtensionHandler<ProviderStreamEvent>): () => void;
	on(
		event: "before_agent_start",
		handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>,
	): () => void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
	on(
		event: "agent_before_settle",
		handler: ExtensionHandler<AgentBeforeSettleEvent, AgentBeforeSettleEventResult>,
	): () => void;
	on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): () => void;
	on(event: "ui_prompt_start", handler: ExtensionHandler<UIPromptStartEvent>): () => void;
	on(event: "ui_prompt_end", handler: ExtensionHandler<UIPromptEndEvent>): () => void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): () => void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent, TurnEndEventResult>): () => void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): () => void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): () => void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): () => void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): () => void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): () => void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): () => void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): () => void;
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): () => void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): () => void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): () => void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): () => void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): () => void;

	// =========================================================================
	// Tool 注册
	// =========================================================================

	/** 注册一个 LLM 可调用的 tool。 */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;

	// =========================================================================
	// Command、快捷键、Flag 注册
	// =========================================================================

	/** 注册一个自定义 command。 */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

	/** 注册一个键盘快捷键。 */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** 注册一个 CLI flag。 */
	registerFlag(
		name: string,
		options:
			| {
					description?: string;
					type: "boolean";
					default?: boolean;
			  }
			| {
					description?: string;
					type: "string";
					default?: string;
			  },
	): void;

	/** 获取已注册 CLI flag 的值。 */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// Message 渲染
	// =========================================================================

	/** 为 CustomMessageEntry 注册自定义渲染器。 */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	/** 在 Pi 于交互式 transcript 中渲染 user 和 assistant Markdown 之前注册一个转换器。 */
	registerMarkdownTransformer(transformer: MarkdownTransformer): void;

	/** 为 CustomEntry 注册自定义渲染器。Custom entry 不参与 LLM context。 */
	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;

	/** 决定 tool call 如何绘制。resolver 按 extension 加载顺序运行。 */
	registerToolRenderer(resolver: ToolRendererResolver): void;

	// =========================================================================
	// 操作
	// =========================================================================

	/** 向会话发送自定义消息。 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/**
	 * 向 agent 发送用户消息。总是触发一个 turn。
	 * agent 正在 streaming 时，用 deliverAs 指定消息的排队方式。
	 * 设置 expandPromptTemplates 以分发 extension command，并展开 skill command 和 prompt 模板。
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): void;

	/** 向会话追加自定义 entry 用于状态持久化（不发送给 LLM）。 */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	// =========================================================================
	// 会话元数据
	// =========================================================================

	/** 设置会话显示名（显示在会话选择器中）。 */
	setSessionName(name: string): void;

	/** 获取当前会话名称（如已设置）。 */
	getSessionName(): string | undefined;

	/** 设置或清除 entry 上的标签。标签是用户定义的、用于书签/导航的标记。 */
	setLabel(entryId: string, label: string | undefined): void;

	/** 执行 shell 命令。 */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** 获取活跃 tool 的名称，即声明给 model 的那些 tools。 */
	getActiveTools(): string[];

	/** 获取所有已配置 tools 的参数 schema、prompt guidelines、exposure 和来源元数据。 */
	getAllTools(): ToolInfo[];

	/** 获取一份生效 settings 的副本（全局与项目 settings 合并，含覆盖项）。 */
	getSettings(): Settings;

	/**
	 * 按名称设置活跃 tools。未知工具与 `hidden` tool 会被忽略。`codemode` 或
	 * `deferred` exposure 的 tool 无论是否活跃，codemode 脚本都能调用。
	 */
	setActiveTools(toolNames: string[]): void;

	/** 获取当前会话可用的 slash command。 */
	getCommands(): SlashCommandInfo[];

	// =========================================================================
	// Model 与 Thinking Level
	// =========================================================================

	/**
	 * 为当前会话设置 model，但不改变新会话的已配置默认值。
	 * 该 model 的提供商未配置授权时返回 false。
	 */
	setModel(model: Model<any>): Promise<boolean>;

	/** 获取当前 thinking level。 */
	getThinkingLevel(): ThinkingLevel;

	/**
	 * 为当前会话设置 thinking level（会被限制在 model 能力范围内），
	 * 但不改变新会话的已配置默认值。
	 */
	setThinkingLevel(level: ThinkingLevel): void;

	// =========================================================================
	// Provider 注册
	// =========================================================================

	/**
	 * 注册或覆盖一个 model provider。
	 *
	 * 提供 `models` 时：替换该提供商的所有现有模型。
	 * 只提供 `baseUrl` 时：覆盖现有模型的 URL。
	 * 提供 `oauth` 时：注册 OAuth provider 以支持 /login。
	 * 提供 `streamSimple` 时：注册自定义 API stream 处理器。
	 *
	 * 初次加载 extension 期间此调用进入队列，待 runner 绑定其 context 后
	 * 统一生效。此后立即生效，因此可以安全地在 command 处理器或事件
	 * 回调中调用，无需 `/reload`。
	 *
	 * @example
	 * // 注册带自定义模型的新 provider
	 * pi.registerProvider("my-proxy", {
	 *   baseUrl: "https://proxy.example.com",
	 *   apiKey: "$PROXY_API_KEY",
	 *   api: "anthropic-messages",
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4-20250514",
	 *       name: "Claude 4 Sonnet (proxy)",
	 *       reasoning: false,
	 *       input: ["text", "image"],
	 *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	 *       contextWindow: 200000,
	 *       maxTokens: 16384
	 *     }
	 *   ]
	 * });
	 *
	 * @example
	 * // 覆盖现有 provider 的 baseUrl
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 *
	 * @example
	 * // 注册支持 OAuth 的 provider
	 * pi.registerProvider("corporate-ai", {
	 *   baseUrl: "https://ai.corp.com",
	 *   api: "openai-responses",
	 *   models: [...],
	 *   oauth: {
	 *     name: "Corporate AI (SSO)",
	 *     async login(callbacks) { ... },
	 *     async refreshToken(credentials) { ... },
	 *     getApiKey(credentials) { return credentials.access; }
	 *   }
	 * });
	 */
	registerProvider(provider: Provider): void;
	registerProvider(name: string, config: ProviderConfig): void;

	/**
	 * 注销之前注册的 provider。
	 *
	 * 移除该名称提供商下的所有模型，并恢复被它覆盖的所有内置模型。
	 * 提供商当前未注册时没有任何效果。
	 *
	 * 与 `registerProvider` 一样，初次加载阶段之后调用会立即生效。
	 *
	 * @example
	 * pi.unregisterProvider("my-proxy");
	 */
	unregisterProvider(name: string): void;

	// =========================================================================
	// MCP 服务器
	// =========================================================================

	/**
	 * 为本会话注册一个 MCP server，配置与 `mcp.json` 中的 `mcpServers` 条目相同。
	 * 该 server 会和已配置的 server 一起连接：extension 加载期间注册的在
	 * `session_start` 时连接，之后再注册的立刻连接。重复注册同一个名字会
	 * 替换该 extension 之前的注册。
	 *
	 * 注册不会被保存；每次加载都要重新注册。`mcp.json` 中同名 server 优先。
	 * 配置非法或与其他 extension 注册的名字冲突时抛错。当没有任何已加载的
	 * extension 处理 MCP server 时（例如另一个 MCP extension 替换了内置的
	 * 那个），该注册会被报告为 extension 错误。
	 *
	 * @example
	 * pi.registerMcpServer("jira", { url: "https://mcp.example.com/jira" });
	 */
	registerMcpServer(name: string, config: McpServerConfig): void;

	/** 移除本 extension 注册的 MCP server 并关闭其连接。 */
	unregisterMcpServer(name: string): void;

	/** 所有由 extension 注册的 MCP server。供负责连接 MCP server 的 extension 使用。 */
	getMcpServers(): RegisteredMcpServer[];

	/**
	 * 注册一个 virtual model：一个可选择目录项，把每个请求路由到某个物理
	 * model。所选的（`ctx.model`、`model_change` entries）是 virtual model 名；
	 * assistant 消息记录路由器实际挑选的物理 model 和 thinking level。
	 *
	 * `provider` 可以是任意 provider id，包括自带物理模型的，也可以列出
	 * 多个 virtual model。重复注册相同 provider 和 id 会替换该 virtual model。
	 * 见 docs/virtual-models.md。
	 */
	registerVirtualModel<TState = unknown>(model: ExtensionVirtualModel<TState>): void;

	/** 移除用 `registerVirtualModel()` 注册的 virtual model。 */
	unregisterVirtualModel(provider: string, id: string): void;

	/** extension 之间通信的共享事件总线。 */
	events: EventBus;
}

// ============================================================================
// Provider 注册类型
// ============================================================================

/** 通过 pi.registerVirtualModel() 注册的 virtual model。 */
export interface ExtensionVirtualModel<TState = unknown> extends Omit<VirtualModelDefinition<TState>, "route"> {
	/** 类似 `VirtualModelDefinition.route`，但附带 extension context。 */
	route(request: ModelRouteRequest<TState>, ctx: ExtensionContext): ModelRoute<TState> | Promise<ModelRoute<TState>>;
}

/** 通过 pi.registerProvider() 注册 provider 时的配置。 */
export interface ProviderConfig {
	/** 提供商在 UI 中显示的名称。 */
	name?: string;
	/** API endpoint 的 Base URL。定义模型时必填。 */
	baseUrl?: string;
	/** API key 字面量、env 插值（$ENV_VAR 或 ${ENV_VAR}），或以 !command 开头。定义模型时必填（提供 oauth 时除外）。 */
	apiKey?: string;
	/** API 类型。定义模型时在 provider 或 model 层级必填。 */
	api?: Api;
	/**
	 * 自定义 API 可选的 streamSimple 处理器。
	 * context 是规范化后的 transcript：从其 system messages 里读取 prompt 和 tools
	 * （`getCurrentSystemPrompt(context.messages)`、`getCurrentTools(context.messages)`）。
	 * 实现必须在发送 provider 请求前调用 `options.onPayload` 并采纳其返回的
	 * 替换 payload；必须在收到响应后、消费其 body 前调用 `options.onResponse`，
	 * 与内置提供商保持一致。实现可以在规范化之前调用
	 * `options.onProviderStreamEvent(data, model)` 传入已解析的流事件。
	 * 事件数据归 adapter 所有，必须按只读对待。
	 */
	streamSimple?: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	/** 按 image API 索引的图片生成实现。 */
	images?: Partial<Record<ImageApi, ProviderImages>>;
	/** 按 classifier API 索引的分类器实现。 */
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
	/** 附带在请求中的自定义 headers。 */
	headers?: Record<string, string>;
	/** 为 true 时，用解析出的 API key 添加 Authorization: Bearer 头。 */
	authHeader?: boolean;
	/** 要注册的模型。提供时会替换该提供商原有的所有模型。 */
	models?: ProviderModelConfig[];
	/**
	 * 刷新该提供商的模型列表。返回的列表会替换 extension 提供的模型。
	 * 希望目录跨会话持久时，用 context.publish({ persist: entry })。
	 */
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
	/** 用于 /login 支持的 OAuth provider。`id` 会根据 provider 名称自动设置。 */
	oauth?: {
		/** 提供商在登录 UI 中显示的名称。 */
		name: string;
		/** 通过该认证方式的访问是否由提供商订阅支撑。 */
		isSubscription?: boolean;
		/** @deprecated 仅为源码兼容保留；规范 auth 流程会忽略它。 */
		usesCallbackServer?: boolean;
		/** 运行登录流程，返回要持久化的凭据。 */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		/** 刷新过期凭据，返回要持久化的更新凭据。 */
		refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
		/** 把凭据转换为该 provider 的 API key 字符串。 */
		getApiKey(credentials: OAuthCredentials): string;
		/** 旧的同步式、依赖凭据的 model 投影。 */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

interface ProviderModelConfigBase {
	/** Model ID。 */
	id: string;
	/** 显示名称。 */
	name: string;
	/** 该 model 的 API 类型覆盖。 */
	api?: string;
	/** 该 model 的 API endpoint URL 覆盖。 */
	baseUrl?: string;
	/** 支持的输入类型。 */
	input: ("text" | "image")[];
	/** 提供商输入限制与缓存安全的图片预处理元数据。 */
	inputLimits?: AnyModel["inputLimits"];
	/** 每百万 token 成本费率，以及可选的按请求整体计价的输入定价梯度。 */
	cost: AnyModel["cost"];
	/** 该 model 的自定义 headers。 */
	headers?: Record<string, string>;
}

/** Chat model 配置。省略 `type` 时规范化为 `"chat"`。 */
export interface ProviderChatModelConfig extends ProviderModelConfigBase {
	type?: "chat";
	api?: Api;
	/** 该 model 是否支持 extended thinking。 */
	reasoning: boolean;
	/** 把 pi 的 thinking level 映射到 provider/model 专属值；null 表示该档位不受支持。 */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** 每个 retention 档位尽力而为的 prompt cache 生命周期（秒）。未设置则禁用 cache warming。 */
	promptCache?: Model<Api>["promptCache"];
	/** 最大 context window 大小（tokens）。 */
	contextWindow: number;
	/** 最大输出 tokens。 */
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	/** OpenAI 兼容设置。 */
	compat?: Model<Api>["compat"];
}

/** 图片生成 model 配置。 */
export interface ProviderImageModelConfig extends ProviderModelConfigBase {
	type: "image";
	api?: ImageApi;
	output: ("text" | "image")[];
}

/** 结构化分类器 model 配置。 */
export interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
	type: "classifier";
	api?: ClassifierApi;
	contextWindow: number;
}

/** provider 内单个 model 的配置。 */
export type ProviderModelConfig = ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig;

/** Extension 工厂函数类型。支持同步和异步初始化。 */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type InlineExtension =
	| ExtensionFactory
	| {
			/**
			 * 启动 Extensions 列表和错误信息中显示为 `<inline:name>` 的显示名。
			 * 设为 `builtin` 时，extension 在错误和诊断中名为 `builtin:name`。
			 */
			name: string;
			factory: ExtensionFactory;
			/** 在启动 Extensions 列表中略去本 extension。 */
			hidden?: boolean;
			/**
			 * 当另一个 extension 在加载期间注册了与本 extension 相同名字的
			 * tool、command 或 flag 时，放弃本 extension 而不报告冲突。CLI 内置的
			 * MCP、codemode 和 tool search extension 用它，因此比如注册
			 * `/mcp` 的 MCP extension 会替换内置 MCP 支持。工厂依然运行，
			 * 所以它应只注册 tools、commands、flags 和事件处理器。
			 */
			replaceable?: boolean;
			/**
			 * 提供该 `builtin:<name>` extension 的代码，而不是作为 inline extension 加载。
			 * `builtin:<name>` 是文件之类的 extension 资源：默认加载、`pi config` 会
			 * 列出它、`extensions` 设置里的 `-builtin:<name>` 和 `--no-extensions` 会
			 * 禁用它、`-e builtin:<name>` 会显式加载它。它不出现在启动 Extensions
			 * 列表中，且在 project trust 解决之后才加载，因此无法处理 `project_trust`。
			 * CLI 的内置 extension 用它。
			 */
			builtin?: boolean;
	  };

// ============================================================================
// 已加载 Extension 类型
// ============================================================================

export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	extensionPath: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
) => void;

export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

export type SetSessionNameHandler = (name: string) => void;

export type GetSessionNameHandler = () => string | undefined;

export type GetActiveToolsHandler = () => string[];

/** 含名称、描述、参数 schema、prompt guidelines 和来源元数据的 tool 信息。 */
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & {
	exposure: ToolExposure;
	namespace?: ToolNamespace;
	annotations?: ToolAnnotations;
	sourceInfo: SourceInfo;
};

export type GetAllToolsHandler = () => ToolInfo[];

export type GetSettingsHandler = () => Settings;

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => void;

export type RefreshToolsHandler = () => void;

export type SetModelHandler = (model: Model<any>) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel;

export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

export type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * loader 创建的共享状态，注册期与运行期都会用到。
 * 包含 flag 值（注册期间设置默认值，之后再设置 CLI 值）。
 */
export interface ExtensionRuntimeState {
	flagValues: Map<string, boolean | string>;
	/** extension 加载期间排队的旧式 provider-config 注册，runner 绑定时处理。 */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
	/** extension 加载期间排队的原生 pi-ai provider 注册，runner 绑定时处理。 */
	pendingNativeProviderRegistrations: Array<{ provider: Provider; extensionPath: string }>;
	/** extension 加载期间排队的 virtual model 注册，runner 绑定时处理。 */
	pendingVirtualModelRegistrations: Array<{ definition: VirtualModelDefinition; extensionPath: string }>;
	/** 创建 extension context。runner 绑定之前调用会抛错。 */
	createContext: () => ExtensionContext;
	/** 本 extension 实例在运行时被替换后变为陈旧时抛错。 */
	assertActive: () => void;
	/** 在运行时被替换或重载后把本 extension 实例标记为陈旧。 */
	invalidate: (message?: string) => void;
	/** 保留一个 event-bus 订阅，直至本 runtime 被失效。 */
	trackEventBusSubscription: (unsubscribe: () => void) => () => void;
	/**
	 * 注册或注销 provider。
	 *
	 * bindCore() 之前：注册排队等待 / 注销则从队列移除。
	 * bindCore() 之后：直接调用 ModelRegistry 立即生效。
	 */
	registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
	registerNativeProvider: (provider: Provider, extensionPath?: string) => void;
	unregisterProvider: (name: string, extensionPath?: string) => void;
	/** 用 `pi.registerMcpServer()` 注册的 servers。 */
	mcpServers: McpServerRegistry;
	registerVirtualModel: (definition: VirtualModelDefinition, extensionPath?: string) => void;
	unregisterVirtualModel: (provider: string, id: string) => void;
}

/**
 * pi.* API 方法的 action 实现。
 * 提供给 runner.initialize()，随后复制进共享 runtime。
 */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setSessionName: SetSessionNameHandler;
	getSessionName: GetSessionNameHandler;
	setLabel: SetLabelHandler;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	getSettings: GetSettingsHandler;
	setActiveTools: SetActiveToolsHandler;
	refreshTools: RefreshToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * ExtensionContext（事件处理器中的 ctx.*）的 actions。
 * 所有模式都需要。
 */
export interface ExtensionContextActions {
	getModel: () => Model<any> | undefined;
	getScopedModels: () => readonly ScopedModel[];
	isIdle: () => boolean;
	isProjectTrusted: () => boolean;
	getSignal: () => AbortSignal | undefined;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
	getSystemPromptOptions?: () => BuildSystemPromptOptions;
	/** 支撑 `ExtensionToolContext.executeTool()`。没有它嵌套调用会失败。 */
	executeTool?: (
		callerId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	) => Promise<AgentToolCallOutcome>;
	/** 支撑 `ExtensionToolContext.tools`。 */
	getCallableTools?: () => readonly AgentTool[];
}

/**
 * ExtensionCommandContext（command 处理器中的 ctx.*）的 actions。
 * 仅在 extension command 可被调用的 interactive 模式下需要。
 */
export interface ExtensionCommandContextActions {
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	fork: (
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	navigateTree: (
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	) => Promise<{ cancelled: boolean }>;
	switchSession: (
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

/**
 * 完整 runtime = state + actions。
 * 由 loader 创建（actions 为抛错桩），由 runner.initialize() 补全。
 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** 带全部已注册项的已加载 extension。 */
export interface Extension {
	path: string;
	resolvedPath: string;
	hidden?: boolean;
	/** 见 {@link InlineExtension}。 */
	replaceable?: boolean;
	sourceInfo: SourceInfo;
	handlers: Map<string, HandlerFn[]>;
	tools: Map<string, RegisteredTool>;
	messageRenderers: Map<string, MessageRenderer>;
	toolRenderers?: ToolRendererResolver[];
	markdownTransformer?: MarkdownTransformer;
	entryRenderers?: Map<string, EntryRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** extensions 加载的结果。 */
export interface LoadExtensionsResult {
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
	warnings?: Array<{ path: string; warning: string }>;
	/** 共享 runtime——runner.initialize() 之前 actions 都是抛错桩 */
	runtime: ExtensionRuntime;
}

// ============================================================================
// Extension 错误
// ============================================================================

export interface ExtensionError {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}
