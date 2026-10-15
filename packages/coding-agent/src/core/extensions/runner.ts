/**
 * 扩展运行器（Extension runner）——执行扩展并管理其生命周期。
 */

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	getCurrentSystemMessage,
	type ImageContent,
	type Model,
	type Provider,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import type { CacheWarmingAction } from "../cache-warmer.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type { SessionManager } from "../session-manager.ts";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "../system-prompt.ts";
import type { VirtualModelDefinition } from "../virtual-models.ts";
import type {
	AgentBeforeSettleEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BoundaryContextPreview,
	BoundaryResult,
	CacheWarmingDecisionEvent,
	CacheWarmingDecisionEventResult,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	ContextWithSystemEvent,
	EntryRenderer,
	ExecuteToolOptions,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionToolContext,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ProviderConfig,
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionBoundaryDraft,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolRenderers,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	UIPromptKind,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

// 扩展快捷键可能与 keybindings.json 中的标准按键绑定 ID 冲突。
// 这里只预留编辑器全局快捷键，不预留选择器专用按键绑定。
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// 如果多个操作绑定了同一个按键，则保留操作优先，确保无论遍历顺序如何，扩展都无法占用保留快捷键。
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

function isUserBashEventResult(value: unknown): value is UserBashEventResult {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const hasOperations = candidate.operations !== undefined;
	const hasResult = candidate.result !== undefined;
	if (hasOperations === hasResult) return false;

	if (hasOperations) {
		const operations = candidate.operations;
		if (typeof operations !== "object" || operations === null) return false;
		return typeof (operations as Record<string, unknown>).exec === "function";
	}

	const result = candidate.result;
	if (typeof result !== "object" || result === null) return false;
	const resultRecord = result as Record<string, unknown>;
	return (
		typeof resultRecord.output === "string" &&
		"exitCode" in resultRecord &&
		(resultRecord.exitCode === undefined || typeof resultRecord.exitCode === "number") &&
		typeof resultRecord.cancelled === "boolean" &&
		typeof resultRecord.truncated === "boolean" &&
		(resultRecord.fullOutputPath === undefined || typeof resultRecord.fullOutputPath === "string")
	);
}

/** 所有 before_agent_start 处理器的合并结果。 */
interface BeforeAgentStartCombinedResult {
	messages: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/**
 * 由通用 emit() 方法处理的事件。
 * 具有专用 emitXxx() 方法的事件会被排除，以获得更强的类型安全性。
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| ContextWithSystemEvent
	| CacheWarmingDecisionEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
	| TurnEndEvent
	| AgentBeforeSettleEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

type BoundaryBaseEvent =
	| Omit<TurnEndEvent, "entries" | "continue" | "context">
	| Omit<AgentBeforeSettleEvent, "entries" | "continue" | "context">;

interface BoundaryDispatchResult {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	valid: boolean;
}

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/**
 * 向扩展发送 session_shutdown 事件的辅助函数。
 * 如果事件已发出则返回 true；没有处理器时返回 false。
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
): Promise<boolean> {
	if (extensionRunner.hasHandlers("session_shutdown")) {
		await extensionRunner.emit(event);
		return true;
	}
	return false;
}

function snapshotEventHandlers(extensions: Extension[], event: ExtensionEvent["type"]) {
	return extensions.map((ext) => ({ ext, handlers: ext.handlers.get(event)?.slice() ?? [] }));
}

function sameMessages(left: AgentMessage[], right: AgentMessage[]): boolean {
	return left.length === right.length && left.every((message, index) => message === right[index]);
}

/**
 * `context` 处理器执行后重新附加提示词和工具状态。处理器只能看到对话；系统消息由 Pi 管理。
 * 对话未变化时保留所有系统消息的位置，使支持对话中途续接的模型能够保留缓存前缀。
 * 对话发生变化时，将重放后的提示词章节和工具声明合并为一条开头的系统消息，
 * 避免压缩摘要中的裁剪、窗口截取或切片操作将其丢弃。
 */
function restoreSystemMessages(
	current: AgentMessage[],
	visible: AgentMessage[],
	returned: AgentMessage[],
): AgentMessage[] {
	if (sameMessages(returned, visible)) return current;
	const head = getCurrentSystemMessage(current);
	return head ? [head, ...returned] : returned;
}

export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	const errors: ExtensionError[] = [];
	for (const { ext, handlers } of snapshotEventHandlers(extensionsResult.extensions, "project_trust")) {
		// 单个扩展可以为同一事件注册多个处理器。
		// 第一个返回 yes/no 的 project_trust 处理器胜出；返回 undecided 时继续检查后续处理器。
		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(event, ctx)) as ProjectTrustEventResult;
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					extensionPath: ext.path,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}

const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class ExtensionRunner {
	private extensions: Extension[];
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private mode: ExtensionMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private getModel: () => Model<any> | undefined = () => undefined;
	private getScopedModels: () => readonly ScopedModel[] = () => [];
	private isIdleFn: () => boolean = () => true;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () =>
		normalizeBuildSystemPromptOptions({ cwd: this.cwd });
	private executeToolFn: ExtensionContextActions["executeTool"];
	private getCallableToolsFn: () => readonly AgentTool[] = () => [];
	/** 已报告为未处理的已注册 MCP 服务器。 */
	private readonly reportedMcpServers = new Set<string>();
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private uiPromptDepth = 0;
	private activeUIPrompt: { kind: UIPromptKind; title?: string } | undefined;

	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	) {
		this.extensions = extensions;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
	}

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: {
			registerProvider?: (name: string, config: ProviderConfig) => void;
			registerNativeProvider?: (provider: Provider) => void;
			unregisterProvider?: (name: string) => void;
			registerVirtualModel?: (definition: VirtualModelDefinition) => void;
			unregisterVirtualModel?: (provider: string, id: string) => void;
		},
	): void {
		// 将操作复制到共享运行时（所有扩展 API 都引用此对象）。
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.getSettings = actions.getSettings;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		this.runtime.createContext = () => this.createContext();

		// 上下文操作（必需）。
		this.getModel = contextActions.getModel;
		this.getScopedModels = contextActions.getScopedModels;
		this.isIdleFn = contextActions.isIdle;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getSystemPromptOptionsFn =
			contextActions.getSystemPromptOptions ?? (() => normalizeBuildSystemPromptOptions({ cwd: this.cwd }));
		this.executeToolFn = contextActions.executeTool;
		this.getCallableToolsFn = contextActions.getCallableTools ?? (() => []);

		// 从现在起注册的服务器会立即交给连接它们的扩展。此前注册的服务器
		// 加载期间注册的服务器会在 session_start 时读取。
		this.runtime.mcpServers.setChangeListener(() => {
			void this.emit({ type: "mcp_servers_change", servers: this.runtime.mcpServers.list() });
			this.reportUnhandledMcpServers();
		});

		// 刷新扩展加载期间排队等待的提供商注册项。
		for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
			try {
				if (providerActions?.registerProvider) {
					providerActions.registerProvider(name, config);
				} else {
					this.modelRegistry.registerProvider(name, config);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];
		for (const { provider, extensionPath } of this.runtime.pendingNativeProviderRegistrations) {
			try {
				if (providerActions?.registerNativeProvider) {
					providerActions.registerNativeProvider(provider);
				} else {
					this.modelRegistry.registerProvider(provider);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingNativeProviderRegistrations = [];
		const registerVirtualModel = (definition: VirtualModelDefinition) => {
			if (providerActions?.registerVirtualModel) providerActions.registerVirtualModel(definition);
			else this.modelRegistry.registerVirtualModel(definition);
		};
		for (const { definition, extensionPath } of this.runtime.pendingVirtualModelRegistrations) {
			try {
				registerVirtualModel(definition);
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_virtual_model",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingVirtualModelRegistrations = [];

		// 从此处开始，提供商的注册/注销会立即生效，无需执行 /reload。
		this.runtime.registerProvider = (name, config) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.registerNativeProvider = (provider) => {
			if (providerActions?.registerNativeProvider) {
				providerActions.registerNativeProvider(provider);
				return;
			}
			this.modelRegistry.registerProvider(provider);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
		this.runtime.registerVirtualModel = registerVirtualModel;
		this.runtime.unregisterVirtualModel = (provider, id) => {
			if (providerActions?.unregisterVirtualModel) providerActions.unregisterVirtualModel(provider, id);
			else this.modelRegistry.unregisterVirtualModel(provider, id);
		};
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = async () => {};
	}

	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		this.uiContext = uiContext ? this.wrapUIPromptContext(uiContext) : noOpUIContext;
		this.mode = mode;
	}

	private wrapUIPromptContext(ui: ExtensionUIContext): ExtensionUIContext {
		return {
			...ui,
			select: (title, options, opts) => this.withUIPrompt("select", title, () => ui.select(title, options, opts)),
			confirm: (title, message, opts) => this.withUIPrompt("confirm", title, () => ui.confirm(title, message, opts)),
			input: (title, placeholder, opts) =>
				this.withUIPrompt("input", title, () => ui.input(title, placeholder, opts)),
			editor: (title, prefill) => this.withUIPrompt("editor", title, () => ui.editor(title, prefill)),
			custom: (factory, options) => this.withUIPrompt("custom", undefined, () => ui.custom(factory, options)),
		};
	}

	private withUIPrompt<T>(kind: UIPromptKind, title: string | undefined, run: () => Promise<T>): Promise<T> {
		const outerPrompt = this.uiPromptDepth++ === 0;
		if (outerPrompt) {
			this.activeUIPrompt = { kind, title };
			this.emitUIPromptEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind, ...(title ? { title } : {}) });
		}

		const finish = () => {
			if (--this.uiPromptDepth > 0) return;
			this.uiPromptDepth = 0;

			const prompt = this.activeUIPrompt ?? { kind, title };
			this.activeUIPrompt = undefined;
			this.emitUIPromptEvent({
				type: "ui_prompt_end",
				reason: "ui_prompt",
				kind: prompt.kind,
				...(prompt.title ? { title: prompt.title } : {}),
			});
		};

		try {
			return run().finally(finish);
		} catch (err) {
			finish();
			throw err;
		}
	}

	private emitUIPromptEvent(event: Extract<RunnerEmitEvent, { type: "ui_prompt_start" | "ui_prompt_end" }>): void {
		queueMicrotask(() => {
			void this.emit(event);
		});
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	/** 获取所有扩展注册的工具；同名工具以最先注册的为准。 */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** 按名称获取工具定义；找不到时返回 undefined。 */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, extensionPath: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						shortcut.extensionPath,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	/**
	 * 没有扩展处理 `mcp_servers_change` 时报告已注册的 MCP 服务器，这表示没有任何扩展会连接它们
	 *（例如，另一个 MCP 扩展替换了内置扩展）。
	 */
	reportUnhandledMcpServers(): void {
		if (this.hasHandlers("mcp_servers_change")) return;
		for (const server of this.runtime.mcpServers.list()) {
			if (this.reportedMcpServers.has(server.name)) continue;
			this.reportedMcpServers.add(server.name);
			this.emitError({
				extensionPath: server.extensionPath,
				event: "register_mcp_server",
				error: `MCP server "${server.name}" is registered, but no loaded extension connects MCP servers; another extension may have replaced the built-in MCP support`,
			});
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getMarkdownTransformers(): MarkdownTransformer[] {
		return this.extensions.flatMap((ext) => (ext.markdownTransformer ? [ext.markdownTransformer] : []));
	}

	/** `toolName` 调用的渲染器：先按加载顺序使用扩展解析器，最后使用 `base`。 */
	resolveToolRenderers(toolName: string, base: () => ToolRenderers | undefined): ToolRenderers | undefined {
		const resolvers = this.extensions.flatMap((ext) => ext.toolRenderers ?? []);
		const resolve = (index: number): ToolRenderers | undefined =>
			index < resolvers.length ? resolvers[index](toolName, () => resolve(index + 1)) : base();
		return resolve(0);
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.entryRenderers?.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	private resolveRegisteredCommands(): ResolvedCommand[] {
		const commands: RegisteredCommand[] = [];
		const counts = new Map<string, number>();

		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				commands.push(command);
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		const seen = new Map<string, number>();
		const takenInvocationNames = new Set<string>();

		return commands.map((command) => {
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			seen.set(command.name, occurrence);

			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			if (takenInvocationNames.has(invocationName)) {
				let suffix = occurrence;
				do {
					suffix++;
					invocationName = `${command.name}:${suffix}`;
				} while (takenInvocationNames.has(invocationName));
			}

			takenInvocationNames.add(invocationName);
			return {
				...command,
				invocationName,
			};
		});
	}

	getModelRegistry(): ModelRegistry {
		return this.modelRegistry;
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return this.resolveRegisteredCommands();
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	/**
	 * 请求正常关闭。由扩展工具和事件处理器调用。
	 * 实际关闭行为由模式通过 bindExtensions() 提供。
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	getActiveTools(): string[] {
		this.assertActive();
		return this.runtime.getActiveTools();
	}

	/**
	 * 创建供事件处理器和工具执行使用的 ExtensionContext。
	 * 上下文值会在调用时解析，因此 bindCore/bindUI 所做的更改会生效。
	 */
	createContext(): ExtensionContext {
		const runner = this;
		const getModel = this.getModel;
		const getScopedModels = this.getScopedModels;
		return {
			get ui() {
				runner.assertActive();
				return runner.uiContext;
			},
			get mode() {
				runner.assertActive();
				return runner.mode;
			},
			get hasUI() {
				runner.assertActive();
				return runner.hasUI();
			},
			get cwd() {
				runner.assertActive();
				return runner.cwd;
			},
			get sessionManager() {
				runner.assertActive();
				return runner.sessionManager;
			},
			get modelRegistry() {
				runner.assertActive();
				return runner.modelRegistry;
			},
			get model() {
				runner.assertActive();
				return getModel();
			},
			get scopedModels() {
				runner.assertActive();
				return getScopedModels();
			},
			get thinkingLevel() {
				runner.assertActive();
				return runner.runtime.getThinkingLevel();
			},
			isIdle: () => {
				runner.assertActive();
				return runner.isIdleFn();
			},
			isProjectTrusted: () => {
				runner.assertActive();
				return runner.isProjectTrustedFn();
			},
			get signal() {
				runner.assertActive();
				return runner.getSignalFn();
			},
			abort: () => {
				runner.assertActive();
				runner.abortFn();
			},
			hasPendingMessages: () => {
				runner.assertActive();
				return runner.hasPendingMessagesFn();
			},
			shutdown: () => {
				runner.assertActive();
				runner.shutdownHandler();
			},
			getContextUsage: () => {
				runner.assertActive();
				return runner.getContextUsageFn();
			},
			compact: (options) => {
				runner.assertActive();
				runner.compactFn(options);
			},
			getSystemPrompt: () => {
				runner.assertActive();
				return runner.getSystemPromptFn();
			},
		};
	}

	/**
	 * 为工具调用 `toolCallId` 创建执行上下文：包含扩展上下文以及 `tools` 和 `executeTool()`。
	 * `signal` 是嵌套调用使用的默认信号。
	 */
	createToolContext(toolCallId: string, signal: AbortSignal | undefined): ExtensionToolContext {
		const runner = this;
		// createContext() 会返回新对象，因此添加属性不会影响其他上下文。
		return Object.defineProperties(this.createContext() as ExtensionToolContext, {
			tools: {
				get() {
					runner.assertActive();
					return runner.getCallableToolsFn();
				},
			},
			executeTool: {
				value: async (name: string, args: unknown, options: ExecuteToolOptions = {}) => {
					runner.assertActive();
					if (!runner.executeToolFn) {
						return {
							toolCall: { type: "toolCall", id: `${toolCallId}/0`, name, arguments: {} },
							result: {
								content: [{ type: "text", text: "Nested tool calls are not available in this context" }],
								details: {},
							},
							isError: true,
						};
					}
					return runner.executeToolFn(toolCallId, name, args, { ...options, signal: options.signal ?? signal });
				},
			},
		});
	}

	createCommandContext(): ExtensionCommandContext {
		// 使用属性描述符而非对象展开，以便 createContext() 中受保护的 getter 保持惰性。
		// 对象展开会立即读取这些 getter，并将旧值固定到返回对象中，从而绕过过期实例检查。
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionCommandContext;
		context.getSystemPromptOptions = () => {
			this.assertActive();
			return this.getSystemPromptOptionsFn();
		};
		context.waitForIdle = () => {
			this.assertActive();
			return this.waitForIdleFn();
		};
		context.newSession = (options) => {
			this.assertActive();
			return this.newSessionHandler(options);
		};
		context.fork = (entryId, options) => {
			this.assertActive();
			return this.forkHandler(entryId, options);
		};
		context.navigateTree = (targetId, options) => {
			this.assertActive();
			return this.navigateTreeHandler(targetId, options);
		};
		context.switchSession = (sessionPath, options) => {
			this.assertActive();
			return this.switchSessionHandler(sessionPath, options);
		};
		context.reload = () => {
			this.assertActive();
			return this.reloadHandler();
		};
		return context;
	}

	async emitBoundary(
		baseEvent: BoundaryBaseEvent,
		buildContext: (entries: SessionBoundaryDraft[]) => BoundaryContextPreview | Promise<BoundaryContextPreview>,
	): Promise<BoundaryDispatchResult> {
		const ctx = this.createContext();
		let entries: SessionBoundaryDraft[] = [];
		let shouldContinue = false;
		let context = await buildContext(entries);
		let valid = true;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, baseEvent.type)) {
			for (const handler of handlers) {
				const event = {
					...baseEvent,
					entries,
					continue: shouldContinue,
					context,
				} as TurnEndEvent | AgentBeforeSettleEvent;
				try {
					const handlerResult = (await handler(event, ctx)) as BoundaryResult | undefined;
					if (handlerResult?.entries !== undefined) entries = handlerResult.entries;
					if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
				} catch (err) {
					this.emitError({
						extensionPath: ext.path,
						event: baseEvent.type,
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}

				try {
					context = await buildContext(entries);
					valid = true;
				} catch (err) {
					valid = false;
					this.emitError({
						extensionPath: ext.path,
						event: baseEvent.type,
						error: `Invalid boundary entries: ${err instanceof Error ? err.message : String(err)}`,
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}

		return valid
			? { entries, continue: shouldContinue, context, valid: true }
			: { entries: [], continue: false, context, valid: false };
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const ctx = this.createContext();
		let result: SessionBeforeEventResult | undefined;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {
			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = handlerResult as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: message,
						stack,
					});
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	/** 返回事件自身的操作，除非处理器覆盖了它；存在多个覆盖时以最后一次为准。 */
	async emitCacheWarmingDecision(event: CacheWarmingDecisionEvent): Promise<CacheWarmingAction> {
		const ctx = this.createContext();
		let action = event.action;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {
			for (const handler of handlers) {
				try {
					const result = (await handler(event, ctx)) as CacheWarmingDecisionEventResult | undefined;
					if (result?.action !== undefined) action = result.action;
				} catch (err) {
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}

		return action;
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "message_end")) {
			for (const handler of handlers) {
				try {
					const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
					const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
					if (!handlerResult?.message) continue;

					if (handlerResult.message.role !== currentMessage.role) {
						this.emitError({
							extensionPath: ext.path,
							event: "message_end",
							error: "message_end handlers must return a message with the same role",
						});
						continue;
					}

					currentMessage = handlerResult.message;
					modified = true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "message_end",
						error: message,
						stack,
					});
				}
			}
		}

		return modified ? currentMessage : undefined;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "tool_result")) {
			for (const handler of handlers) {
				try {
					const handlerResult = (await handler(currentEvent, ctx)) as ToolResultEventResult | undefined;
					if (!handlerResult) continue;

					if (handlerResult.content !== undefined) {
						currentEvent.content = handlerResult.content;
						// 如果结构化内容未随正文一起替换，它可能不再与正文匹配。
						if (handlerResult.structuredContent === undefined) delete currentEvent.structuredContent;
						modified = true;
					}
					if (handlerResult.details !== undefined) {
						currentEvent.details = handlerResult.details;
						modified = true;
					}
					if (handlerResult.structuredContent !== undefined) {
						currentEvent.structuredContent = handlerResult.structuredContent;
						modified = true;
					}
					if (handlerResult.isError !== undefined) {
						currentEvent.isError = handlerResult.isError;
						modified = true;
					}
					if (handlerResult.usage !== undefined) {
						currentEvent.usage = handlerResult.usage;
						modified = true;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_result",
						error: message,
						stack,
					});
				}
			}
		}

		if (!modified) {
			return undefined;
		}

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			structuredContent: currentEvent.structuredContent,
			isError: currentEvent.isError,
			usage: currentEvent.usage,
		};
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;

		for (const { handlers } of snapshotEventHandlers(this.extensions, "tool_call")) {
			for (const handler of handlers) {
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		const ctx = this.createContext();

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "user_bash")) {
			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);
					if (handlerResult === undefined) continue;
					if (!isUserBashEventResult(handlerResult)) {
						throw new Error(
							"Invalid user_bash handler result: return undefined for local execution or exactly one valid { operations } or { result } object",
						);
					}
					return handlerResult;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "user_bash",
						error: message,
						stack,
					});
					throw err;
				}
			}
		}

		return undefined;
	}

	/**
	 * 分两个阶段运行请求期间的转换。`context` 处理器只看到对话；每个处理器执行后，Pi 会恢复提示和工具状态。
	 * 随后，`context_with_system` 处理器会看到完整记录，并直接采用其返回结果。
	 */
	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.createContext();
		let currentMessages = structuredClone(messages);

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "context")) {
			for (const handler of handlers) {
				try {
					const visibleMessages = currentMessages.filter((message) => message.role !== "system");
					const visibleSnapshot = visibleMessages.slice();
					const event: ContextEvent = { type: "context", messages: visibleMessages };
					const handlerResult = (await handler(event, ctx)) as ContextEventResult | undefined;

					// 处理器可以返回新列表，也可以直接修改 event.messages。
					const returned =
						handlerResult?.messages ??
						(sameMessages(visibleMessages, visibleSnapshot) ? undefined : visibleMessages);
					if (!returned) continue;
					currentMessages = restoreSystemMessages(currentMessages, visibleSnapshot, returned);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "context",
						error: message,
						stack,
					});
				}
			}
		}

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "context_with_system")) {
			for (const handler of handlers) {
				try {
					const hadLeadingSystemMessage = currentMessages[0]?.role === "system";
					const event: ContextWithSystemEvent = { type: "context_with_system", messages: currentMessages };
					const handlerResult = (await handler(event, ctx)) as ContextEventResult | undefined;
					currentMessages = handlerResult?.messages ?? currentMessages;
					// 提供方会从开头的系统消息读取提示词和初始工具。
					// 不应移除此消息；若处理器仍将其移除，则报告问题，但保留处理器的输出。
					if (hadLeadingSystemMessage && currentMessages[0]?.role !== "system") {
						this.emitError({
							extensionPath: ext.path,
							event: "context_with_system",
							error: "Handler removed the leading system message; the request has no prompt or initial tool declarations. Keep it at index 0 or replace a dropped prefix with getCurrentSystemMessage().",
						});
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "context_with_system",
						error: message,
						stack,
					});
				}
			}
		}

		return currentMessages;
	}

	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		const ctx = this.createContext();
		let currentPayload = payload;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_provider_request")) {
			for (const handler of handlers) {
				try {
					const event: BeforeProviderRequestEvent = {
						type: "before_provider_request",
						payload: currentPayload,
					};
					const handlerResult = await handler(event, ctx);
					if (handlerResult !== undefined) {
						currentPayload = handlerResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_request",
						error: message,
						stack,
					});
				}
			}
		}

		return currentPayload;
	}

	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		const ctx = this.createContext();

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_provider_headers")) {
			for (const handler of handlers) {
				try {
					// 处理器会直接修改 `headers`；其返回值会被忽略。
					const event: BeforeProviderHeadersEvent = {
						type: "before_provider_headers",
						headers,
					};
					await handler(event, ctx);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_headers",
						error: message,
						stack,
					});
				}
			}
		}

		return headers;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<BeforeAgentStartCombinedResult> {
		const currentOptions = normalizeBuildSystemPromptOptions(systemPromptOptions);
		const renderCurrentSystemPrompt = (): string => buildSystemPrompt(currentOptions);
		const ctx = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionContext;
		ctx.getSystemPrompt = () => {
			this.assertActive();
			return renderCurrentSystemPrompt();
		};
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_agent_start")) {
			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = {
						type: "before_agent_start",
						prompt,
						images,
						get systemPrompt() {
							return renderCurrentSystemPrompt();
						},
						systemPromptOptions: currentOptions,
					};
					const handlerResult = await handler(event, ctx);

					if (handlerResult) {
						const result = handlerResult as BeforeAgentStartEventResult;
						if (result.message) messages.push(result.message);
						if (result.systemPrompt !== undefined) {
							currentOptions.forceSystemPrompt = result.systemPrompt;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_agent_start",
						error: message,
						stack,
					});
				}
			}
		}

		return { messages, systemPromptOptions: currentOptions };
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "resources_discover")) {
			for (const handler of handlers) {
				try {
					const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
					const handlerResult = await handler(event, ctx);
					const result = handlerResult as ResourcesDiscoverResult | undefined;

					if (result?.skillPaths?.length) {
						skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.promptPaths?.length) {
						promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.themePaths?.length) {
						themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "resources_discover",
						error: message,
						stack,
					});
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** 发送输入事件。变换按链式顺序执行；返回“已处理”时会提前结束。 */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputEventResult> {
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "input")) {
			for (const handler of handlers) {
				try {
					const event: InputEvent = {
						type: "input",
						text: currentText,
						images: currentImages,
						source,
						streamingBehavior,
					};
					const result = (await handler(event, ctx)) as InputEventResult | undefined;
					if (result?.action === "handled") return result;
					if (result?.action === "transform") {
						currentText = result.text;
						currentImages = result.images ?? currentImages;
					}
				} catch (err) {
					this.emitError({
						extensionPath: ext.path,
						event: "input",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}
