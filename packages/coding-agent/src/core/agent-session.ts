/**
 * AgentSession：智能体生命周期和会话管理的核心抽象。
 *
 * 所有运行模式（交互、打印、RPC）共用此类。
 * 它封装了：
 * - 智能体状态访问
 * - 事件订阅和会话自动持久化
 * - 模型和思考等级管理
 * - 上下文压缩（手动和自动）
 * - Bash 执行
 * - 会话切换与分支管理
 *
 * 各运行模式基于此类添加各自的输入输出层。
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type PrepareNextTurnContext,
	runToolCall,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { contentText, getCurrentSystemMessage, retryDelayMs } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import type { CacheWarmer, CacheWarmingStatus } from "./cache-warmer.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextUsage,
	type ExecuteToolOptions,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolExposure,
	type ToolInfo,
	type ToolLoadout,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { createToolNameMatcher, isMcpToolName } from "./mcp-servers.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "./session-manager.ts";
import {
	applyToolModifiers,
	type CacheWarmingMode,
	DEFAULT_TOOL_NAMES,
	type SettingsManager,
} from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, combineUsage, createUsageTotals } from "./usage-totals.ts";
import {
	findLatestResponse,
	getBranchSelection,
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "./virtual-models.ts";

// ============================================================================
// 技能块解析。
// ============================================================================

/** 从用户消息中解析出的技能块。 */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * 从消息文本中解析技能块。
 * 如果文本中不包含技能块，则返回 null。
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** 工具通过 `ctx.executeTool()` 发起调用时，其工具执行事件会包含 `parentToolCallId`。 */
type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

/** 扩展核心 AgentEvent 的会话专属事件。 */
export type AgentSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled"; aborted: boolean }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** 智能体会话事件的监听函数。 */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// 类型定义。
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** 通过 Ctrl+P 切换的模型（来自 --models 参数）。 */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** 用于加载扩展、技能、提示词、主题、上下文文件和系统提示词的加载器。 */
	resourceLoader: ResourceLoader;
	/** 在扩展之外注册的 SDK 自定义工具。 */
	customTools?: ToolDefinition[];
	/** coding-agent 内部使用的标准模型和身份验证运行时。 */
	modelRuntime: ModelRuntime;
	/** 保持会话最近一次请求对应的提示词缓存条目处于热状态。 */
	cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
	/** 初始启用的内置工具名称。默认值：[read, bash, edit, write]。 */
	initialActiveToolNames?: string[];
	/**
	 * 初始工具是否来自 `defaultTools` 设置。为 true 时，重新加载会启用新加入设置的工具，
	 * 从设置中移除的工具仍保持启用。
	 */
	usesDefaultTools?: boolean;
	/**
	 * 通过 `--tools` 在 `defaultTools` 设置上追加的 `+name`/`-name` 项。
	 * 重新加载时也会应用这些修改，因此被移除的工具仍保持移除状态。
	 */
	defaultToolModifiers?: string[];
	/**
	 * 可选的工具名称或模式允许列表（`*` 匹配任意字符）。设置后，只公开匹配的工具。
	 * 列表非空且不含 `mcp__` 项时，MCP 工具仍会注册供 codemode 和 tool_search 使用，但只有 tool_search 可以声明它们。
	 * 列表为空时，不公开任何工具。
	 */
	allowedToolNames?: string[];
	/** 可选的工具名称或模式拒绝列表。设置后，匹配的工具不会公开。 */
	excludedToolNames?: string[];
	/**
	 * 覆盖基础工具（适用于自定义运行时）。
	 *
	 * 内部会为这些工具合成最精简的 ToolDefinitions，使 AgentSession 在调用方只提供普通 AgentTool 实例时，
	 * 仍能维护以定义为主的注册表。
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** 可变引用，供 Agent 访问当前的 ExtensionRunner。 */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** 扩展绑定到此运行时后发出的会话启动事件元数据。 */
	sessionStartEvent?: SessionStartEvent;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

/** AgentSession.prompt() 的选项。 */
export interface PromptOptions {
	/** 是否分发扩展命令并展开技能命令和提示词模板（默认：true）。 */
	expandPromptTemplates?: boolean;
	/** 图片附件。 */
	images?: ImageContent[];
	/** 流式输出期间消息的排队方式："steer"（中断当前轮次）或 "followUp"（等待当前轮次结束）；流式输出时必填。 */
	streamingBehavior?: "steer" | "followUp";
	/** 扩展输入事件处理器的输入来源，默认为 "interactive"。 */
	source?: InputSource;
	/** RPC 模式使用的内部钩子，用于观察已接受的提示词如何分发；提示词被拒绝时不会调用。 */
	preflightResult?: (disposition: PromptDisposition) => void;
}

/** 修改模型或思考级别时使用的选项。 */
export interface ModelMutationOptions {
	/** 是否将新值保存到全局默认设置；默认仅应用于当前会话。 */
	persist?: boolean;
}

/** cycleModel() 的返回结果。 */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** 表示是在限定模型（--models 参数）中切换，还是在所有可用模型中切换。 */
	isScoped: boolean;
}

/** /session 命令使用的会话统计信息。 */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// AgentSession 类。
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// 事件订阅状态。
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _agentRunAbortRequested = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** 跟踪待处理的引导消息以供界面显示；消息送达后移除。 */
	private _steeringMessages: string[] = [];
	/** 跟踪待处理的后续消息以供界面显示；消息送达后移除。 */
	private _followUpMessages: string[] = [];
	/** 排队等待加入下一条用户提示词上下文的消息（旁注）。 */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** 运行期间排队的纯上下文自定义消息；当前轮次的工具结果全部返回后再写入。 */
	private _pendingCustomMessages: CustomMessage[] = [];

	// 压缩状态。
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// 分支摘要状态。
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// 重试状态。
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/**
	 * 下一次请求会重复发送的失败响应，由自动重试和溢出恢复逻辑设置。
	 * 由于上下文已不再包含该响应，重试请求会将其作为 `failed` 路由。
	 */
	private _failedResponse: AssistantMessage | undefined;

	// Bash 执行状态。
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// 扩展系统。
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	private _lastAssistantMessage: AssistantMessage | undefined;
	private _lastAssistantToolResults: AgentMessage[] = [];
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	private _isBeforeSettle = false;
	private _abortDuringBeforeSettle = false;
	private _isEmittingAgentSettled = false;
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	/**
	 * 已恢复或重新加载的工具配置中尚未注册的工具，例如仍在连接中的 MCP 服务器提供的工具。
	 * 工具注册后会启用；调用 `setActiveToolsByName()` 停用该工具或下一次智能体运行开始时，会将其移除。
	 */
	private _pendingToolNames = new Set<string>();
	private _usesDefaultTools: boolean;
	private _defaultToolModifiers: string[];
	/** 与 `--tools` 条目匹配：工具名称或匹配模式。 */
	private _allowedTools?: (name: string) => boolean;
	/**
	 * 检查允许列表是否会筛选 MCP 工具：允许列表为空（`--no-tools`）或包含 MCP 工具名称
	 *（`mcp__*`）时会进行筛选；否则会保留已注册的 MCP 工具，供 codemode 和 tool_search 使用。
	 */
	private _allowlistFiltersMcp = false;
	private _excludedTools?: (name: string) => boolean;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;

	// 供扩展 getTools/setTools 使用的工具注册表。
	private _toolRegistry: Map<string, AgentTool> = new Map();
	/** 首次调用 `ctx.executeTool()` 时创建。 */
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	/** `prepareLoadout` 钩子要求从请求中省略声明的工具。 */
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** 当前运行中经 before_agent_start 修改后的提示词选项。 */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._cacheWarmer = config.cacheWarmer;
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._usesDefaultTools = config.usesDefaultTools ?? false;
		this._defaultToolModifiers = config.defaultToolModifiers ?? [];
		if (config.allowedToolNames) {
			this._allowedTools = createToolNameMatcher(config.allowedToolNames);
			this._allowlistFiltersMcp =
				config.allowedToolNames.length === 0 || config.allowedToolNames.some((entry) => entry.startsWith("mcp__"));
		}
		this._excludedTools = config.excludedToolNames ? createToolNameMatcher(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// 始终订阅智能体事件，以便执行内部处理
		//（会话持久化、扩展、自动压缩和重试逻辑）。
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentRequestProjection();
		this._installAgentBoundaryHooks();
		this._installHiddenDeclarationsProjection();
		this._installAgentForcedPromptProjection();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		if (this._initialActiveToolNames === undefined) this._restoreToolsFromTranscript();
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model, { signal });
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(
		selectedModel: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		thinkingLevel: ThinkingLevel;
	}> {
		// 先路由虚拟模型：摘要的输入和输出规模应根据实际使用的模型确定。
		const { model, thinkingLevel } = isVirtualModel(selectedModel)
			? await this._modelRuntime.resolveModel(selectedModel, convertToLlm(this.messages), {
					reason: "direct",
					thinkingLevel: this.thinkingLevel,
					signal,
				})
			: { model: selectedModel, thinkingLevel: this.thinkingLevel };
		if (this.agent.streamFunction === streamSimple) {
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model, thinkingLevel };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
				thinkingLevel,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return { model, thinkingLevel };
		}
	}

	/**
	 * 对 `message` 应用限制的模型；如果消息来自其他模型，则返回 undefined。
	 * 选择虚拟模型时，此处返回实际生成该消息的物理模型。
	 */
	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const model = this.model;
		if (model && isVirtualModel(model)) return this._modelRuntime.getPhysicalModel(message.provider, message.model);
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/**
	 * 如果当前分支隐含的模型选择与当前选择不同，则将当前选择记录到分支，以便恢复会话时还原。
	 * 树导航可能导致最新的 `model_change` 留在其他分支；响应只能记录物理模型，无法记录虚拟模型选择。
	 * 除非分支上记录的是虚拟模型，否则响应会记录物理模型选择。如果将物理模型选择与响应比较，
	 * 每次 `prepareRequest` 将请求重定向到其他模型时，都会重复记录该选择。
	 */
	private _recordSelection(): void {
		const model = this.model;
		if (!model) return;
		const getModel = (provider: string, modelId: string) => this._modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(this.sessionManager.getBranch(), getModel);
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	/** 对当前对话应用限制的模型。 */
	private _limitsModel(): Model<any> | undefined {
		return this.routedModel?.model ?? this.model;
	}

	/**
	 * 在 Agent 实例上安装一次工具钩子。
	 *
	 * 回调会在执行时读取 `this._extensionRunner`，因此重新加载扩展时只需替换运行器，无需重新安装钩子。
	 * 仍通过扩展专用工具包装器，将已注册工具的执行适配到扩展上下文。工具调用和结果的拦截现由此处处理，
	 * 不再由包装器处理。
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = (context) => this._beforeToolCall(context);
		this.agent.afterToolCall = (context) => this._afterToolCall(context);
	}

	/** `tool_call` 事件处理器。调用来自其他工具时会设置 `parentToolCallId`。 */
	private async _beforeToolCall(
		{ toolCall, args }: BeforeToolCallContext,
		parentToolCallId?: string,
	): Promise<BeforeToolCallResult | undefined> {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				...(parentToolCallId ? { parentToolCallId } : {}),
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	/** `tool_result` 事件处理器和图片规范化逻辑。调用来自其他工具时会设置 `parentToolCallId`。 */
	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		// 在扩展钩子之后运行，以便规范化扩展注入或替换的图片。
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		// 钩子结果已丢弃结构化内容，因为替换后的内容与原结构化内容不再匹配。
		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	/**
	 * 执行工具调用 `parentToolCallId` 通过 `ctx.executeTool()` 发起的调用。
	 * 调用会针对可调用工具经过智能体工具处理流程，并运行会话钩子。
	 */
	private async _executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this._getCallableTools(),
			isSequential: () => this.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = this._findLastAssistantMessage();
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: { content: [{ type: "text", text: "No assistant message issued this call" }], details: {} },
						isError: true,
					});
				}
				return runToolCall(toolCall, {
					tools: this._getCallableTools(),
					assistantMessage,
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					beforeToolCall: (context) => this._beforeToolCall(context, parentId),
					afterToolCall: (context) => this._afterToolCall(context, parentId),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await this._extensionRunner.emit(event);
				this._emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/** 检查当前会话投影 `projection` 是否超过模型 `model` 的压缩阈值。 */
	private _exceedsCompactionThreshold(model: Model<any>, projection: SessionProjection): boolean {
		if (model.contextWindow <= 0) return false;
		return shouldCompact(
			estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
			model.contextWindow,
			this.settingsManager.getCompactionSettings(this.model),
		);
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const projection = this.sessionManager.buildSessionProjection();
		// 虚拟模型选择会在 prepareRequest 中根据请求实际路由到的模型进行检查。
		const model = this.model;
		if (!model || isVirtualModel(model) || !this._exceedsCompactionThreshold(model, projection)) {
			return { ...context, messages: projection.messages };
		}
		await this._runAutoCompaction("threshold", false);
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	private _installAgentRequestProjection(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			const failed = this._failedResponse;
			this._failedResponse = undefined;
			const prepare = async () => {
				const projection = this.sessionManager.buildSessionProjection();
				const canonicalContext = {
					...request.context,
					messages: projection.messages,
					// messages 声明提供商可见的工具配置；context.tools 保留可执行的工具实现。
					tools: this.agent.state.tools.slice(),
				};
				const previous = await previousPrepareRequest?.(
					{
						...request,
						context: canonicalContext,
						model: this.agent.state.model,
						thinkingLevel: this.agent.state.thinkingLevel,
					},
					signal,
				);
				return { previous, context: previous?.context ?? canonicalContext, projection };
			};
			let { previous, context, projection } = await prepare();
			const model = previous?.model ?? this.agent.state.model;
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			if (!isVirtualModel(model)) return { ...previous, context, model, thinkingLevel };

			// 模型选择仍保留在智能体状态中，只有当前请求使用路由后的模型。路由失败会导致 Promise 拒绝，
			// 本次运行随后以错误响应结束。只有用户编写的消息会开启新轮次；扩展消息可以跟在其后，
			// 例如 before_agent_start 事件处理器添加的消息。
			const lastResponse = context.messages.findLastIndex((message) => message.role === "assistant");
			const userTurn = context.messages.slice(lastResponse + 1).some((message) => message.role === "user");
			const state = getVirtualModelState(this.sessionManager.getBranch(), model.provider, model.id);
			const route = await this._modelRuntime.resolveModel(model, convertToLlm(context.messages), {
				reason: failed ? "retry" : userTurn ? "user" : "continuation",
				thinkingLevel,
				signal,
				failed,
				state,
			});
			if (route.state !== undefined && route.state !== state) {
				const data: VirtualModelStateData = { provider: model.provider, modelId: model.id, state: route.state };
				const entry = this.sessionManager.getEntry(
					this.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data),
				);
				if (entry) this._emit({ type: "entry_appended", entry });
			}
			// 路由结果已确定，路由器已经为当前请求做出决定。状态条目不会改变会话投影。
			if (this._exceedsCompactionThreshold(route.model, projection)) {
				await this._runAutoCompaction("threshold", false);
				({ previous, context } = await prepare());
			}
			return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		const messageEntryId = this._findPersistedMessageEntryId(message);
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this._findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		const boundary = await this._extensionRunner.emitBoundary(
			{
				type: "turn_end",
				turnIndex: this._turnIndex,
				message,
				toolResults,
				messageEntryId,
				toolResultEntryIds,
				outcome: this._lastActivityOutcome,
			},
			(entries) => this._buildBoundaryContext(entries, "turn_end"),
		);
		this._commitBoundaryDrafts(boundary.entries);
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			this._reportInvalidBoundaryContinuation("turn_end");
			return false;
		}
		return boundary.continue;
	}

	private _installAgentBoundaryHooks(): void {
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			const previousDecision = await previousFinishTurn?.(turn, signal);
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const context = await this._compactBeforeNextAssistantResponse(turn.context);
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
			const nextContext = previousSnapshot?.context ?? context;
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			const options = normalizeBuildSystemPromptOptions({
				...runOptions,
				selectedTools: this.getActiveToolNames(),
				toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
				toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
			});
			const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
			// 确保 session.systemPrompt 和 ctx.getSystemPrompt() 与提供商实际收到的内容一致。
			this._runSystemPromptOptions = options;

			return {
				...previousSnapshot,
				context: {
					...nextContext,
					tools: this.agent.state.tools.slice(),
				},
				messages: updateMessage
					? [...(previousSnapshot?.messages ?? []), updateMessage]
					: previousSnapshot?.messages,
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// 事件订阅。
	// =========================================================================

	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.agent.state.messages = projection.messages;
	}

	private _applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (const draft of drafts) {
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = manager.appendCustomMessageEntry(
						draft.customType,
						draft.content,
						draft.display,
						draft.details,
					);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				case "compaction": {
					const tokensBefore = estimateProjectedContextTokens(
						manager.buildSessionProjection(),
						manager.getBranch(),
					).tokens;
					entryId = manager.appendCompaction(
						draft.summary,
						draft.firstKeptEntryId,
						tokensBefore,
						draft.details,
						true,
						draft.usage,
					);
					break;
				}
			}
			const entry = manager.getEntry(entryId);
			if (entry) appended.push(entry);
		}
		return appended;
	}

	private _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager {
		const header = this.sessionManager.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
		this._applyBoundaryDrafts(manager, drafts);
		return manager;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview {
		const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
		const pendingMessages = this._getPendingBoundaryMessages();
		const llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
		const pendingCustomContext = this._pendingCustomMessages.length > 0;
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end"
					? this.agent.hasQueuedMessages()
					: finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void {
		const appended = this._applyBoundaryDrafts(this.sessionManager, drafts);
		this._refreshFinalizedContext();
		for (const entry of appended) this._emit({ type: "entry_appended", entry });
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	/** 向所有监听器发送事件。 */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		this._isEmittingAgentSettled = true;
		try {
			const aborted = this._agentRunAbortRequested;
			await this._extensionRunner.emit({ type: "agent_settled", aborted });
			this._emit({ type: "agent_settled", aborted });
		} finally {
			this._isEmittingAgentSettled = false;
		}

		const deferred = this._deferredSettledActions.splice(0);
		if (deferred.length > 0) {
			try {
				for (const action of deferred) await action();
			} finally {
				this._resolveIdleWaitIfIdle();
			}
			return;
		}
		this._resolveIdleWaitIfIdle();
	}

	/** 智能体事件的内部处理器，供订阅和重连共用。 */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// 记录工具通过 ctx.executeTool() 发起的调用及其结果消息中的用量。
		if (this._nestedToolCalls) {
			if (event.type === "message_start" && event.message.role === "toolResult") {
				const message = event.message;
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				if (summary?.calls) message.nestedCalls = summary.calls;
				if (summary?.usage) {
					message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
				}
			} else if (event.type === "agent_end") {
				this._nestedToolCalls.clear();
			}
		}
		// 用户消息开始时，检查它是否来自任一队列，并在发出事件前将其移除。
		// 这样 UI 收到事件时就能看到更新后的队列状态。
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// 先检查引导消息队列。
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// 再检查后续消息队列。
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// 先向扩展发出事件，再通知公开监听器。
		await this._emitExtensionEvent(event);
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// 处理会话持久化。
		if (event.type === "message_end") {
			let entryId: string | undefined;
			// 检查是否为扩展发出的自定义消息。
			if (event.message.role === "custom") {
				// 持久化为 CustomMessageEntry。
				entryId = this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "system" ||
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// 普通 LLM 消息：持久化为 SessionMessageEntry。
				entryId = this.sessionManager.appendMessage(event.message);
			}
			if (entryId) this._entryIdsByMessage.set(event.message, entryId);
			// 其他消息类型（bashExecution、compactionSummary、branchSummary）会在其他位置持久化。

			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this._lastAssistantMessage = assistantMsg;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// 助手响应成功后立即重置重试计数器。
				// 避免同一轮次中的多次 LLM 调用累积重试次数。
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}

		// 一轮会在助手消息及所有工具结果都追加后结束，因此此时首次可以插入仅供上下文使用的自定义消息，
		// 且不会落在工具调用与其结果之间。在上方完成扩展事件和监听器分发后再刷新，
		// 也能处理 turn_end 事件处理器加入的消息。
		if (event.type === "turn_end") {
			this._lastAssistantToolResults = event.toolResults;
			this._flushPendingCustomMessages();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this._agentRunAbortRequested) return false;
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex === messageIndex) {
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					return entry.sourceEntry.id;
				}
				projectedIndex++;
			}
		}
		return undefined;
	}

	private _omitRecoveryAttempt(message: AssistantMessage, toolResults: AgentMessage[] = []): void {
		const targets = [message, ...toolResults];
		const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
		const unresolvedProjectedTarget = targets.some(
			(target, index) => targetIds[index] === undefined && this.agent.state.messages.includes(target),
		);
		if (unresolvedProjectedTarget) {
			throw new Error("Cannot persist recovery omission because a projected message has no source entry");
		}
		for (const targetId of targetIds) {
			if (!targetId) continue;
			const editId = this.sessionManager.appendContextEdit(targetId, null);
			const entry = this.sessionManager.getEntry(editId);
			if (entry) this._emit({ type: "entry_appended", entry });
		}
		this._refreshFinalizedContext();
	}

	/** 查找智能体状态中的最后一条助手消息（包括已中止的消息）。 */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core 会先将最终消息对象存入自身状态，再发出 message_end。
		// SessionManager 稍后会在 _handleAgentEvent() 中使用 event.message 持久化消息。
		// 原地修改该对象可确保智能体状态、后续轮次和智能体事件、监听器，以及最终调用
		// SessionManager.appendMessage(event.message) 的持久化内容保持一致。
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** 根据智能体事件向扩展发出对应事件。 */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
				await this._dispatchTurnEndBoundary(event.message, event.toolResults);
			}
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// 未经类型检查的扩展处理器可能返回 content 为 null 或缺失的消息；
				// 此处进行规范化，避免这类消息进入智能体状态或会话历史。
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
				...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * 订阅智能体事件。
	 * 会话持久化在内部处理（在 message_end 时保存消息）。
	 * 可添加多个监听器；返回用于取消订阅此监听器的函数。
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// 返回用于取消此监听器订阅的函数。
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** 销毁时断开智能体事件监听。 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * 移除所有监听器并断开与智能体的连接。
	 * 会话完全结束时调用。
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// 即使中止钩子抛出异常，释放操作也必须成功。
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = undefined;
			this._cacheWarmer.cancel();
		}
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// 只读状态访问。
	// =========================================================================

	/** 根据规范会话投影刷新对外提供的最终记录。 */
	refreshContext(): void {
		this._refreshFinalizedContext();
	}

	/** 完整的智能体状态。 */
	get state(): AgentState {
		return this.agent.state;
	}

	/** 当前缓存预热状态及决定该状态的策略输入。 */
	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		return this._cacheWarmer?.status;
	}

	/** 持久化缓存预热模式，并立即协调当前的预热状态。 */
	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.settingsManager.setCacheWarmingMode(mode);
		this._cacheWarmer?.onModeChanged();
	}

	/** 当前模型；尚未选择时可能为 undefined。 */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** 当前思考级别。 */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** 使用虚拟选择时，最近一次成功响应实际使用的模型和思考级别。 */
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		if (!this.model || !isVirtualModel(this.model)) return undefined;
		const latest = findLatestResponse(this.agent.state.messages);
		const model = latest && this._modelRuntime.getPhysicalModel(latest.provider, latest.model);
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	/** 会话当前是否正在运行智能体或处理运行后的延续任务。 */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** 会话是否没有正在运行的智能体、压缩、分支摘要、重试或排队中的延续任务。 */
	get isIdle(): boolean {
		return !this._isAgentRunActive && !this.isCompacting;
	}

	/** 当前生效的系统提示词，包括尚未发送给模型的修改。 */
	get systemPrompt(): string {
		return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
	}

	/** 当前重试次数（未重试时为 0）。 */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * 获取当前启用的工具名称，也就是已向模型声明的工具。
	 * 暴露方式为 `codemode` 或 `deferred` 的工具无需启用，也可由其他工具调用。
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** 获取工具可通过 `ctx.executeTool()` 调用的工具名称。 */
	getCallableToolNames(): string[] {
		return this._getCallableTools().map((t) => t.name);
	}

	/**
	 * 获取所有已配置工具的信息，包括名称、描述、参数架构、提示词指南和来源元数据。
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			exposure: this._getToolExposure(definition.name),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * 按名称设置启用的工具。
	 * 只能启用注册表中的工具；未知或隐藏的工具名称会被忽略。
	 * 同时重建系统提示词，使其反映新的工具集。
	 * 更改会在智能体下一轮运行时生效。
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const previous = this.getActiveToolNames();
		this._setActiveTools(toolNames);
		// 如果新配置停用了工具，就会替换已恢复的配置，并清除其中尚待注册的工具。
		// 如果新配置只添加工具（例如启用 tool_search），则保留原配置。
		const active = new Set(this.getActiveToolNames());
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
	}

	private _setActiveTools(toolNames: string[]): void {
		const tools = this._applyToolLoadout(toolNames);
		for (const tool of tools) this._pendingToolNames.delete(tool.name);
		this._rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	/**
	 * 判断 `--tools` 和 `--exclude-tools` 设置是否应保留工具的注册状态。除非允许列表会筛选 MCP 工具
	 *（参见 `_allowlistFiltersMcp`），否则 MCP 工具始终保持注册。
	 */
	private _isAllowedTool(name: string): boolean {
		if (this._excludedTools?.(name)) return false;
		if (!this._allowedTools || this._allowedTools(name)) return true;
		return !this._allowlistFiltersMcp && isMcpToolName(name);
	}

	/**
	 * 判断工具是否可以启用并向模型声明。允许列表保留但未匹配到的 MCP 工具仅供 codemode 和 tool_search 使用；
	 * 只有 tool_search 能加载它们时才可声明（暴露方式不是 `direct`，且 tool_search 已注册）。
	 * 从会话记录恢复或由扩展设置的工具也遵循此规则。
	 */
	private _isActivatable(name: string): boolean {
		if (!this._allowedTools || this._allowedTools(name) || !isMcpToolName(name)) return true;
		return this._getToolExposure(name) !== "direct" && this._toolRegistry.has("tool_search");
	}

	private _getToolExposure(name: string): ToolExposure {
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/**
	 * 可通过 `ctx.executeTool()` 调用的工具：已启用的 `direct` 工具，以及所有已注册的 `codemode` 或 `deferred` 工具。
	 */
	private _getCallableTools(active: ReadonlySet<string> = new Set(this.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter((tool) => {
			const exposure = this._getToolExposure(tool.name);
			return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * 根据给定的启用工具名称设置智能体工具并返回这些工具。启用的工具是已注册且未隐藏的工具，并会向模型声明。
	 * 带有 `prepareLoadout` 钩子的启用工具可以修改已声明的描述，并从请求中隐藏工具声明
	 *（参见 {@link _installHiddenDeclarationsProjection}）。
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const tools = [...new Set(toolNames)].flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool && this._getToolExposure(name) !== "hidden" && this._isActivatable(name) ? [tool] : [];
		});
		const hooks = tools.flatMap((tool) => {
			const entry = this._toolDefinitions.get(tool.name);
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		const hidden = new Set<string>();
		let declared = tools;
		if (hooks.length > 0) {
			const loadout: ToolLoadout = {
				declared: tools,
				callable: this._getCallableTools(new Set(tools.map((tool) => tool.name))),
				registered: [...this._toolRegistry.values()],
				getExposure: (name) => this._getToolExposure(name),
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
				getPromptGuidelines: (name) => this._toolPromptGuidelines.get(name) ?? [],
			};
			const descriptions = new Map<string, string>();
			for (const { definition, sourceInfo } of hooks) {
				try {
					const changes = definition.prepareLoadout?.(loadout);
					for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
						descriptions.set(name, description);
					}
					for (const name of changes?.hiddenDeclarations ?? []) hidden.add(name);
				} catch (error) {
					this._extensionRunner.emitError({
						extensionPath: sourceInfo.path,
						event: "prepare_loadout",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
			declared = tools.map((tool) => {
				const description = descriptions.get(tool.name);
				return description === undefined ? tool : { ...tool, description };
			});
		}
		this._hiddenDeclarations = hidden;
		this.agent.state.tools = declared;
		return declared;
	}

	/** 当前是否正在执行上下文压缩或分支摘要生成。 */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** 所有消息，包括 BashExecutionMessage 等自定义类型。 */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** 当前引导消息处理模式。 */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** 当前后续消息处理模式。 */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** 当前会话文件路径；未启用会话时为 undefined。 */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** 当前会话 ID。 */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** 当前会话的显示名称（如果已设置）。 */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** 可切换的限定模型列表（来自 --models 参数）。 */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** 更新可切换的限定模型列表。 */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** 基于文件的提示词模板。 */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		for (const name of this._toolRegistry.keys()) {
			const snippet = this._toolPromptSnippets.get(name);
			// 不包含片段的工具不会列出。
			if (snippet) toolSnippets[name] = snippet;
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			hiddenTools: [...this._hiddenDeclarations],
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		});
	}

	/**
	 * 为下一次请求应用提示词和工具配置，设置可执行工具，并返回用于修补模型当前提示词分区的系统消息
	 *（这些分区会从 `messages` 中重放）；如果提示词没有变化，则返回 undefined。
	 * 工具变更会由智能体循环在请求前声明。
	 *
	 * 强制提示词不会影响会话记录：结构化分区仍会进行差异比较并持久化，
	 * 强制文本则由 {@link _installAgentForcedPromptProjection} 投影到请求中。
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		// 工具列表和规则必须与请求携带的声明一致。
		options.hiddenTools = [...this._hiddenDeclarations];
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * 将强制提示词作为提供商请求开头的系统提示词发送，但不记录到会话中。
	 *
	 * 返回 `systemPrompt` 的 `before_agent_start` 处理器要求请求开头使用这段确切文本；如果将其作为对话中途的
	 * 系统消息，原提示词仍会保留。强制文本是当前提示词的渲染结果，因此会话记录继续保存结构化分区，
	 * 请求则使用投影结果：所有系统消息合并为一条开头消息，其中包含强制文本和当前工具列表。
	 * 此处理在 `context` 扩展处理器之后运行。
	 */
	/**
	 * 从每次请求中移除 `prepareLoadout` 钩子隐藏的工具声明。整个会话记录都会按照当前集合筛选，
	 * 因此投影后的声明在不同请求间保持一致，只有工具配置变化时才会改变。
	 */
	private _installHiddenDeclarationsProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const hidden = this._hiddenDeclarations;
			if (hidden.size === 0) return transformed;
			return transformed.map((message) => {
				if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
				const { toolsAdded, toolsRemoved, ...rest } = message;
				const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
				const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
				return {
					...rest,
					...(added.length > 0 ? { toolsAdded: added } : {}),
					...(removed.length > 0 ? { toolsRemoved: removed } : {}),
				};
			});
		};
	}

	private _installAgentForcedPromptProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			if (forced === undefined) return transformed;
			const current = getCurrentSystemMessage(transformed);
			const head: SystemMessage = {
				role: "system",
				content: forced,
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				timestamp: current?.timestamp ?? Date.now(),
			};
			return [head, ...transformed.filter((message) => message.role !== "system")];
		};
	}

	/**
	 * 如果会话记录声明了启用的工具配置，则恢复该配置。
	 * 只能由其他工具调用的工具不会被声明，但它们不依赖启用集合，因此会话记录中的声明就是完整配置。
	 */
	private _restoreToolsFromTranscript(): void {
		this._pendingToolNames.clear();
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const names = (current.toolsAdded ?? []).map((tool) => tool.name);
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		this._setActiveTools(names);
	}

	// =========================================================================
	// 提示词处理。
	// =========================================================================

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._agentRunAbortRequested = false;
		// 提示词发送前的压缩可能已安排重试；新提示词会取代该重试。
		this._failedResponse = undefined;
		this._recordSelection();
		// 本次运行会将工具配置记录到会话中；此时仍未注册的已恢复工具会被移除，
		// 因此永远不会注册的工具不会一直处于待处理状态。
		this._pendingToolNames.clear();
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (!this._agentRunAbortRequested) {
				if (await this._handlePostAgentRun()) {
					if (this._agentRunAbortRequested) break;
					await this.agent.continue();
					continue;
				}
				if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested) break;
				await this.agent.continue();
			}
		} finally {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = undefined;
			this._runSystemPromptOptions = undefined;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			await this._emitAgentSettled();
		}
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();

		if (this._isRetryableError(message) && (await this._prepareRetry(message))) {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = message;
			return !this._agentRunAbortRequested;
		}
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}

		if (message.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(message, true, toolResults)) {
			return !this._agentRunAbortRequested;
		}

		// 底层循环会在 agent_end 之前清空两个队列。agent_end 处理器加入的消息需要启动新一轮运行，
		// 才会触发结算前处理器。
		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
	}

	private async _runBeforeSettleBoundary(): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("agent_before_settle")) return this.agent.hasQueuedMessages();
		this._isBeforeSettle = true;
		this._abortDuringBeforeSettle = false;
		try {
			const result = await this._extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			this._commitBoundaryDrafts(result.entries);
			this._flushPendingCustomMessages();
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (this._abortDuringBeforeSettle) return false;
			const shouldContinue = result.continue || this.agent.hasQueuedMessages();
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} finally {
			this._isBeforeSettle = false;
		}
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
		if (inputResult.action === "handled") {
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images };
		}
		return { text, images };
	}

	private async _normalizePromptImages(
		images: ImageContent[] | undefined,
	): Promise<{ images: ImageContent[]; hints: string[] }> {
		if (!images) return { images: [], hints: [] };

		const normalizedImages: ImageContent[] = [];
		const hints: string[] = [];
		for (const image of images) {
			const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				resizeOptions: this._limitsModel()?.inputLimits?.images?.resize,
			});
			if (!processed.ok) {
				hints.push(processed.message);
				continue;
			}
			normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			hints.push(...processed.hints);
		}
		return { images: normalizedImages, hints };
	}

	/**
	 * 向智能体发送提示词。
	 * - 立即处理扩展命令（通过 pi.registerCommand 注册），即使当前正在流式输出。
	 * - 默认展开基于文件的提示词模板。
	 * - 流式输出期间，根据 streamingBehavior 选项通过 steer() 或 followUp() 将消息排队。
	 * - 非流式输出时，发送前验证模型和 API 密钥。
	 * @throws 流式输出期间未指定 streamingBehavior 时抛出错误。
	 * @throws 非流式输出且未选择模型或没有可用 API 密钥时抛出错误。
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => await this.prompt(text, options));
			return;
		}
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		// 优先处理扩展命令（即使正在流式输出，也会立即执行）。
		// 扩展命令通过 pi.sendMessage() 自行管理与 LLM 的交互。
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this._tryExecuteExtensionCommand(text);
			if (handled) {
				// 扩展命令已执行，无需发送提示词。
				preflightResult?.("handled");
				return;
			}
		}

		if (this._compactionAbortController !== undefined) {
			throw new Error(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		}

		// 发出输入事件供扩展拦截（在展开技能和模板之前）。
		const processedInput = await this._runInputHandlers(
			text,
			options?.images,
			options?.source ?? "interactive",
			this.isStreaming ? options?.streamingBehavior : undefined,
		);
		if (!processedInput) {
			preflightResult?.("handled");
			return;
		}
		const { text: currentText, images: currentImages } = processedInput;

		// 展开技能命令（/skill:name args）和提示词模板（/template args）。
		let expandedText = currentText;
		if (expandPromptTemplates) {
			expandedText = this._expandSkillCommand(expandedText);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}

		// 如果正在流式输出，则根据选项通过 steer() 或 followUp() 将消息加入队列。
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			if (options.streamingBehavior === "followUp") {
				await this._queueFollowUp(expandedText, currentImages);
			} else {
				await this._queueSteer(expandedText, currentImages);
			}
			preflightResult?.("queued");
			return;
		}

		// 发送新提示词之前，先刷新待处理的 Bash 消息和自定义消息。
		this._flushPendingBashMessages();
		this._flushPendingCustomMessages();

		// 验证模型。
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		const hasConfiguredAuth =
			this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
			(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
		if (!hasConfiguredAuth) {
			const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
			if (isOAuth) {
				throw new Error(
					`Authentication failed for "${this.model.provider}". ` +
						`Credentials may have expired or network is unavailable. ` +
						`Run '/login ${this.model.provider}' to re-authenticate.`,
				);
			}
			throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
		}

		// 检查发送提示词前是否需要压缩（包括处理已中止的响应）。
		// 下方会发送用户的新提示词，因此此处不要调用 agent.continue()。
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) {
			await this._checkCompaction(lastAssistant, false);
		}

		// 先发出 before_agent_start，再规范化图片，这样扩展选择的模型可以决定请求和历史记录使用的缩放配置。
		const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
		const result = await this._extensionRunner.emitBeforeAgentStart(
			expandedText,
			currentImages,
			this._baseSystemPromptOptions,
		);
		// 处理器可以修改 event.systemPromptOptions.selectedTools，也可以调用 setActiveTools() 直接更新当前工具配置。
		// 显式修改优先；否则以当前工具配置为准，避免在此处撤销 setActiveTools() 的修改。
		const handlerEditedTools =
			result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
			result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
		if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();

		const normalized = await this._normalizePromptImages(currentImages);
		const userText = normalized.hints.length > 0 ? `${expandedText}\n\n${normalized.hints.join("\n")}` : expandedText;

		// 等钩子执行完毕且图片规范化完成后，再构建消息。
		const messages: AgentMessage[] = [];
		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: userText }];
		userContent.push(...normalized.images);
		messages.push({
			role: "user",
			content: userContent,
			timestamp: Date.now(),
		});

		// 将所有待处理的 "nextTurn" 消息与用户消息一起注入上下文。
		for (const msg of this._pendingNextTurnMessages) {
			messages.push(msg);
		}
		this._pendingNextTurnMessages = [];

		for (const msg of result.messages) {
			messages.push({
				role: "custom",
				customType: msg.customType,
				// 未经类型检查的扩展可能传入 null 或缺失的内容；在接收时进行规范化。
				content: msg.content ?? [],
				display: msg.display,
				details: msg.details,
				timestamp: Date.now(),
			});
		}
		const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		this._runSystemPromptOptions = result.systemPromptOptions;
		if (updateMessage) messages.unshift(updateMessage);

		preflightResult?.("started");
		await this._runAgentPrompt(messages);
	}

	/**
	 * 尝试执行扩展命令。找到并执行命令时返回 true。
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// 解析命令名称和参数。
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// 从扩展运行器获取命令上下文（包含会话控制方法）。
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// 通过扩展运行器发出错误事件。
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * 将技能命令（/skill:name args）展开为完整内容。
	 * 返回展开后的文本；如果不是技能命令或找不到技能，则返回原文本。
	 * 读取文件失败时，通过扩展运行器发出错误事件。
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // 遇到未知技能时原样传递。

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// 与扩展命令相同，通过扩展运行器发出错误事件。
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // 出错时返回原始文本。
		}
	}

	private async _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
	): Promise<QueuedInputDisposition> {
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		const processedInput = await this._runInputHandlers(
			text,
			images,
			source,
			this.isStreaming ? behavior : undefined,
		);
		if (!processedInput) return "handled";

		let expandedText = this._expandSkillCommand(processedInput.text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		if (behavior === "steer") {
			await this._queueSteer(expandedText, processedInput.images);
		} else {
			await this._queueFollowUp(expandedText, processedInput.images);
		}
		return "queued";
	}

	/**
	 * 在智能体运行期间，将引导消息加入队列。
	 * 当前助手轮次完成工具调用后、下一次调用 LLM 之前发送。
	 * 会展开技能命令和提示词模板；遇到扩展命令时会报错。
	 * @param images 要随消息附带的可选图片。
	 * @param options 输入来源；默认为 interactive。
	 * @throws text 是扩展命令时抛出错误。
	 */
	async steer(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "steer", options?.source ?? "interactive");
	}

	/**
	 * 将后续消息加入队列，等待智能体运行结束后处理。
	 * 只有智能体没有待执行的工具调用或引导消息时才会发送。
	 * 会展开技能命令和提示词模板；遇到扩展命令时会报错。
	 * @param images 要随消息附带的可选图片。
	 * @param options 输入来源；默认为 interactive。
	 * @throws text 是扩展命令时抛出错误。
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "followUp", options?.source ?? "interactive");
	}

	/**
	 * 内部方法：将引导消息加入队列（内容已展开，不检查扩展命令）。
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * 内部方法：将后续消息加入队列（内容已展开，不检查扩展命令）。
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({ role: "user", content, timestamp: Date.now() });
	}

	/**
	 * 如果文本是扩展命令，则抛出错误。
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * 向会话发送自定义消息，并创建 CustomMessageEntry。
	 *
	 * 处理以下四种情况：
	 * - 正在流式处理中：将消息排入队列，循环取出时处理。
	 * - 正在流式处理中且 `triggerTurn` 为 false：当前轮次结束后追加到状态和会话。
	 * - 未在流式处理中且 `triggerTurn` 为 true：追加到状态和会话，并开始新一轮。
	 * - 未在流式处理中且不触发新轮次：追加到状态和会话，不开始新一轮。
	 *
	 * @param message 包含 customType、content、display 和 details 的自定义消息。
	 * @param options.triggerTurn 为 true 且当前未流式处理时，触发新一轮 LLM 调用。
	 * @param options.deliverAs 消息传递模式："steer"、"followUp" 或 "nextTurn"。
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// 未经类型检查的扩展可能传入 null 或缺失的内容；在接收时进行规范化。
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			if (this._isEmittingAgentSettled) {
				this._deferredSettledActions.push(async () => await this._runAgentPrompt(appMessage));
				return;
			}
			await this._runAgentPrompt(appMessage);
		} else if (this.isStreaming) {
			// 现在追加会让消息出现在助手的工具调用及其结果之间，按消息顺序校验的提供商在重放时会拒绝这种顺序。
			// 因此延迟到本轮结束时追加。此时不会发出任何事件：消息事件不能描述会话树中尚不存在的消息。
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this._refreshFinalizedContext();
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * 追加智能体运行期间排队的自定义消息。
	 * 当前轮次的工具结果写入智能体状态和会话历史后调用。
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * 向智能体发送用户消息，并始终触发新一轮运行。
	 * 智能体正在流式输出时，使用 deliverAs 指定消息的排队方式。
	 *
	 * @param content 用户消息内容（字符串或内容数组）。
	 * @param options.deliverAs 流式输出时的交付方式："steer" 或 "followUp"。
	 * @param options.expandPromptTemplates 是否分发扩展命令并展开技能命令和提示词模板。默认：false。
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// 将内容规范化为文本字符串和可选图片。
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * 清除并返回所有排队消息。
	 * 用户中止操作时，可用于将消息恢复到编辑器中。
	 * @returns 包含 steering 和 followUp 数组的对象。
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** 待处理消息数量，包括引导消息和后续消息。 */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** 获取待处理的引导消息（只读）。 */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** 获取待处理的后续消息（只读）。 */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * 中止当前操作并等待智能体进入空闲状态。
	 */
	async abort(): Promise<void> {
		if (this._isAgentRunActive) {
			this._agentRunAbortRequested = true;
		}
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// 模型管理。
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * 直接设置模型。
	 * 验证身份验证配置是否可用，并将模型选择保存到会话记录。
	 * 只有 options.persist 为 true 时，才会保存到全局默认设置。
	 * @throws 未为该模型配置身份验证时抛出错误。
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// 应用新模型的思考等级。
		// 模型专属思考等级优先于全局默认值。
		// 持久化模型选择不会隐式改写全局思考等级默认值。
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * 切换到下一个或上一个模型。
	 * 如果设置了限定模型（--models 参数），则在其中切换；否则遍历所有可用模型。
	 * @param direction 切换方向："forward"（默认）或 "backward"。
	 * @returns 新模型的信息；只有一个可用模型时返回 undefined。
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// 应用模型。
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// 应用新模型的思考级别。
		// - 显式指定的作用域模型思考等级会覆盖默认值。
		// - 单模型思考等级的优先级高于全局默认值。
		// setThinkingLevel 会根据模型能力限制思考等级。
		// 持久化模型不会隐式改写全局思考级别默认值。
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// 应用新模型的思考级别。
		// 持久化模型不会隐式改写全局思考级别默认值。
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// 思考级别管理。
	// =========================================================================

	/**
	 * 设置思考级别。
	 * 根据模型支持的思考级别限制所设级别。
	 * 仅当级别确实发生变化时，才将限制后的级别保存到会话记录。
	 * 仅当 options.persist 为 true 时，才将请求的级别保存为全局默认值。
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// 仅在级别确实发生变化时持久化。
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * 切换到下一个思考级别。
	 * @returns 新级别；模型不支持思考功能时返回 undefined。
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * 获取当前模型可用的思考级别。
	 * 提供商会在内部将级别限制为该模型实际支持的范围。
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * 检查当前模型是否支持思考或推理。
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// 切换到具有模型专属默认值的模型时，优先采用该默认值。
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// 消息队列模式管理。
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * 设置引导消息模式，并保存到设置中。
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * 设置后续消息模式，并保存到设置中。
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// 上下文压缩。
	// =========================================================================

	/** 使用 Pi 内置的摘要生成器，为手动和自动压缩生成摘要。 */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		model: Model<any>,
		customInstructions: string | undefined,
		signal: AbortSignal,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		// 只有 Pi 自行生成摘要时才解析此请求；路由过程可能会调用模型或失败。
		const request = await this._getSummarizationRequestAuth(model, signal);
		return compact(
			preparation,
			request.model,
			request.apiKey,
			request.headers,
			customInstructions,
			signal,
			request.thinkingLevel,
			this.agent.streamFunction,
			request.env,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			undefined, // sessionId
		);
	}

	private _clearManualCompactionState(): void {
		this._compactionAbortController = undefined;
		this._resolveIdleWaitIfIdle();
	}

	/**
	 * 手动压缩会话上下文。
	 *
	 * 这是 `/compact`、RPC 和扩展使用的手动入口，与通过 `_checkCompaction()` 和
	 * `_runAutoCompaction()` 触发的阈值或溢出自动压缩分开。完成准备并执行
	 * `session_before_compact` 钩子后，两条路径都会调用从 `./compaction/index.ts` 导入的
	 * 底层 `compact()` 函数，除非钩子取消操作或提供自定义结果。
	 *
	 * 首先中止当前智能体操作。手动压缩不会重试或继续已中断的智能体轮次。
	 *
	 * @param customInstructions 压缩摘要的可选指令。
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			const model = this.model;
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const settings = this.settingsManager.getCompactionSettings(model);
			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// 检查无法压缩的原因。
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// 使用扩展提供的压缩内容。
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// 使用共享的默认摘要生成器；自动压缩也会使用它。
				const result = await this._runDefaultCompaction(
					preparation,
					model,
					customInstructions,
					this._compactionAbortController.signal,
					"manual",
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// 获取已保存的压缩条目，供扩展事件使用。
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end 监听器可能会提交排队中的提示，因此通知监听器前先将状态设为空闲。
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = this._compactionAbortController.signal.aborted || cancelledByExtension;
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw error;
		} finally {
			this._clearManualCompactionState();
		}
	}

	/**
	 * 取消正在进行的压缩（手动或自动）。
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * 取消正在进行的分支摘要生成。
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * 在 `agent_end` 之后或提交提示词之前触发自动压缩。
	 * 手动压缩不会调用此方法，而是通过 `compact()` 进入。
	 *
	 * 自动压缩的触发情形：
	 * 1. 溢出并重试：发生上下文溢出错误或可恢复的长度终止；移除失败的助手消息，
	 *    压缩上下文，并重试一次该轮次。
	 * 2. 溢出但不重试：成功响应超过配置的上下文窗口；压缩上下文，但保留已完成的响应。
	 * 3. 达到阈值但不重试：有效或估算的上下文用量超过配置阈值；压缩上下文，不重试已完成的响应。
	 *
	 * 每种情形都会调用 `_runAutoCompaction()`。完成准备并执行 `session_before_compact` 钩子后，
	 * 该方法会调用从 `./compaction/index.ts` 导入的底层 `compact()` 函数，除非钩子取消操作
	 * 或提供自定义结果。
	 *
	 * @param assistantMessage 要检查的助手消息。
	 * @param skipAbortedCheck 为 false 时也检查已中止的消息（用于提示词发送前的检查）。默认：true。
	 * @returns 后续运行循环是否应调用 `agent.continue()` 来恢复溢出或处理排队消息。
	 */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		toolResults: AgentMessage[] = [],
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings(this.model);
		if (!settings.enabled) return false;

		// 如果消息已中止（用户取消），则跳过检查；skipAbortedCheck 为 false 时除外。
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		// 如果消息来自其他模型，则跳过溢出检查。
		// 例如，用户从上下文较小的模型（如 opus）切换到上下文较大的模型（如 codex）时，
		// 旧模型的溢出错误不应触发新模型的压缩。选择虚拟模型时，限制值由生成该消息的物理模型提供。
		const messageModel = this._modelForMessage(assistantMessage);
		const sameModel = messageModel !== undefined;
		const contextWindow = (messageModel ?? this.model)?.contextWindow ?? 0;

		// 如果此助手消息早于最近一次压缩边界，则跳过压缩检查。
		// 这样可避免压缩前的旧用量或错误在压缩后的第一个提示中再次触发压缩。
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// 自动处理情形 1 和 2：上下文溢出。
		// 如果输出在模型原定的最大长度之前因长度限制停止，则可以恢复，
		// 不受已配置的上下文大小或提供商请求长度限制影响。
		const currentProjection = this.sessionManager.buildSessionProjection();
		const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
		const assistantIsProjected =
			assistantEntryId === undefined ||
			currentProjection.entries.some(
				(entry) =>
					entry.sourceEntry.id === assistantEntryId &&
					entry.messages.some((message) => message.role === "assistant"),
			);
		const branch = this.sessionManager.getBranch();
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		const latestAssistantEdit = entriesAfterAssistant
			.filter(
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			.at(-1);
		const assistantRetainedForExplicitRecovery =
			assistantEntryId === undefined ||
			(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
				latestAssistantEdit?.replacement !== null);
		const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		const contextOverflow =
			sameModel &&
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		const recoverableLength =
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// 情形 2：响应已成功完成。执行压缩，但不重试，因为 agent.continue() 无法从已完成的助手响应继续。
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			// 在运行结束后的恢复压缩前，持久化省略本次选定的最终尝试。
			this._overflowRecoveryAttempted = true;
			this._omitRecoveryAttempt(assistantMessage, toolResults);
			const retry = await this._runAutoCompaction("overflow", willRetry);
			if (retry) this._failedResponse = assistantMessage;
			return retry;
		}

		// 情形 3：达到阈值时压缩，不重试。
		// 对于错误消息或用量全为零的消息，根据最近一次有效响应估算。
		// 这样，即使会话持续遇到 API 错误（例如 529）或收到格式错误且用量为零的响应，
		// 仍可执行压缩，且不会重置上下文用量统计。
		let contextTokens: number;
		const projection = currentProjection;
		const hasContextEdits = projection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (hasContextEdits) {
			contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
		} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// 没有提供商用量时，estimate.tokens 是纯粹根据消息大小得出的估算值。
			// 只有基于实际用量的估算才需要检查数据是否来自压缩前。
			if (estimate.lastUsageIndex !== null) {
				// 确认用量来源是压缩之后的响应。保留的压缩前消息记录着旧的（更大的）上下文用量，
				// 若据此判断，会在压缩刚完成后错误地再次触发压缩。
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * 执行阈值压缩或溢出恢复压缩。手动压缩则使用 `AgentSession.compact()`。
	 * 两种路径都会先完成准备并允许扩展拦截，然后调用从 `./compaction/index.ts` 导入的底层 `compact()` 函数。
	 *
	 * @param reason `_checkCompaction()` 选择的自动触发原因。
	 * @param willRetry 是否在上下文溢出压缩后继续被中断的轮次。
	 * @returns 后续循环是否应调用 `agent.continue()`。
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		let abortController: AbortController | undefined;
		let started = false;
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			if (!model) {
				return false;
			}

			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			abortController = new AbortController();
			this._autoCompactionAbortController = abortController;
			started = true;
			this._emit({ type: "compaction_start", reason });
			abortController.signal.throwIfAborted();

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: abortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}
			abortController.signal.throwIfAborted();

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// 使用扩展提供的压缩内容。
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// 使用共享的默认摘要生成器，手动压缩也会使用它。
				const compactResult = await this._runDefaultCompaction(
					preparation,
					model,
					undefined,
					abortController.signal,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}
			abortController.signal.throwIfAborted();

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			// 获取已保存的压缩条目，以便向扩展发出事件。
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) return true;

			// 自动压缩可能在后续消息、引导消息或自定义消息仍在等待时完成。
			// 因此继续运行一次，以便发送队列中的消息。
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = abortController?.signal.aborted === true || cancelledByExtension;
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason,
					errorMessage,
					aborted,
					willRetry: false,
					fromExtension,
				});
			}
			return false;
		} finally {
			if (this._autoCompactionAbortController === abortController) {
				this._autoCompactionAbortController = undefined;
			}
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * 切换自动压缩设置。
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** 自动压缩是否已启用。 */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		this._extensionRunner.reportUnhandledMcpServers();
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = isSyntheticPath(entry.extensionPath) ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (isSyntheticPath(extensionPath)) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				getSettings: () => this.settingsManager.getSettings(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
				executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => this._getCallableTools(),
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
				registerVirtualModel: (definition) => {
					this._modelRuntime.registerVirtualModel(definition);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterVirtualModel: (provider, id) => {
					this._modelRuntime.unregisterVirtualModel(provider, id);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// 注册时已激活的工具。工具暴露方式变为 `direct` 或 `model-only`（例如从 `hidden` 变更）时，
		// 会像新工具一样激活。
		const previousActivatedOnRegistration = new Set(
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedTools = this._allowedTools;

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => this._isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => this._isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => this._isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
						source: "builtin",
					}),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => this._isAllowedTool(name));

		if (allowedTools) {
			for (const toolName of this._toolRegistry.keys()) {
				// 即使工具默认未激活，明确指定名称或匹配到它也会激活该工具。
				// 保持注册但未被指定的 MCP 工具仍处于未激活状态。
				if (allowedTools(toolName) && this._isDeclarable(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				if (this._isActivatedOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousActivatedOnRegistration.has(toolName) && this._isActivatedOnRegistration(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		// 现在已注册的待处理工具将被激活。
		nextActiveToolNames.push(...this._pendingToolNames);

		this._setActiveTools([...new Set(nextActiveToolNames)]);
	}

	/** 激活该工具时是否会将其声明给模型。 */
	private _isDeclarable(name: string): boolean {
		const exposure = this._getToolExposure(name);
		return exposure === "direct" || exposure === "model-only";
	}

	/** 注册该工具时是否会将其激活并声明给模型。 */
	private _isActivatedOnRegistration(name: string): boolean {
		return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		const getDefaultTools = () =>
			this._usesDefaultTools
				? applyToolModifiers(
						this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES,
						this._defaultToolModifiers,
					)
				: [];
		const previousDefaultTools = new Set(getDefaultTools());
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		// 激活新加入 defaultTools 的工具。已移除的工具仍保持激活；会话期间停用的工具也保持停用，
		// 除非设置中重新加入该工具。
		const addedDefaultTools = getDefaultTools().filter((name) => !previousDefaultTools.has(name));
		// 新扩展稍后注册的工具（例如 MCP 工具）在注册前保持待处理状态。
		for (const name of this.getActiveToolNames()) this._pendingToolNames.add(name);
		this._buildRuntime({
			activeToolNames: [...this.getActiveToolNames(), ...addedDefaultTools],
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			this._extensionRunner.reportUnhandledMcpServers();
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// 自动重试。
	// =========================================================================

	/**
	 * 检查错误是否可重试（例如服务过载、触发速率限制或服务器错误）。
	 * 上下文溢出错误不可重试，应由压缩流程处理。
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// 上下文溢出由压缩处理，不进行重试。
		if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * 压缩和分支摘要请求共用的重试策略与回调。
	 * 使用与智能体轮次重试相同的 `settings.retry` 次数预算和退避间隔，避免一次暂时性的
	 * 流中断导致整个操作失败。`source` 携带 TUI 渲染重试状态和重新创建相应指示器所需的上下文。
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	private _finishCancelledRetry(): void {
		if (this._retryAttempt === 0) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/**
	 * 准备以指数退避方式继续重试可重试错误。
	 * @returns 若调用方应继续运行 Agent，则返回 true；否则返回 false。
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// 保留已完成的尝试次数，以便运行结束后的处理能发出最终失败事件。
			this._retryAttempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this._retryAttempt);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// 在原始历史中保留失败尝试，同时从模型投影中持久化排除该尝试。
		this._omitRecoveryAttempt(message);

		// 以可中止的指数退避方式等待。
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// 等待期间被中止：发出结束事件，以便 UI 清理状态。
			this._finishCancelledRetry();
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * 取消正在进行的重试。
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** 是否正在自动重试。 */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** 是否启用了自动重试。 */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * 切换自动重试设置。
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash 执行。
	// =========================================================================

	/**
	 * 执行 Bash 命令。
	 * 将执行结果添加到智能体上下文和会话中。
	 * @param command 要执行的 Bash 命令。
	 * @param onChunk 可选的输出流式回调。
	 * @param options.excludeFromContext 为 true 时，命令输出不会发送给 LLM（使用 `!!` 前缀）。
	 * @param options.id 可选标识符，会包含在 Bash 执行更新事件中。
	 * @param options.operations 用于远程执行的自定义 BashOperations。
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// 如果已配置命令前缀，则应用该前缀（例如使用 "shopt -s expand_aliases" 启用别名）。
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * 将 Bash 执行结果记录到会话历史。
	 * 供 executeBash 和自行处理 Bash 执行的扩展使用。
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// 智能体正在流式输出时，延迟添加消息，以免破坏 tool_use/tool_result 的顺序。
		if (this.isStreaming) {
			// 暂存消息，稍后在 agent_end 时刷新。
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.sessionManager.appendMessage(bashMessage);
			this._refreshFinalizedContext();
		}
	}

	/**
	 * 取消正在运行的 Bash 命令。
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** 当前是否有 Bash 命令正在运行。 */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** 是否有待写入的 Bash 消息。 */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * 将待处理的 Bash 消息刷新到智能体状态和会话中。
	 * 在智能体轮次结束后调用，以保持消息顺序正确。
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			this.sessionManager.appendMessage(bashMessage);
		}
		this._pendingBashMessages = [];
		this._refreshFinalizedContext();
	}

	// =========================================================================
	// 会话管理。
	// =========================================================================

	/**
	 * 设置当前会话的显示名称。
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// 会话树导航。
	// =========================================================================

	/**
	 * 导航到会话树中的其他节点。
	 * 与会创建新会话文件的 fork() 不同，此操作仍使用当前文件。
	 *
	 * @param targetId 要导航到的条目 ID。
	 * @param options.summarize 是否总结被放弃的分支。
	 * @param options.customInstructions 提供给摘要生成器的自定义指令。
	 * @param options.replaceInstructions 为 true 时，customInstructions 会替换默认提示词。
	 * @param options.label 附加到分支摘要条目的标签。
	 * @returns 包含 editorText（若为用户消息）和取消状态的结果。
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// 已位于目标位置时不执行操作。
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// 生成摘要需要有可用模型。
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// 收集需要生成摘要的条目（从旧叶节点到共同祖先）。
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// 准备事件数据，并允许扩展修改。
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// 为摘要生成设置中止控制器。
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// 发出 session_before_tree 事件。
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// 允许扩展覆盖说明和标签。
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// 如有需要，运行默认摘要生成器。
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const signal = this._branchSummaryAbortController.signal;
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					...(await this._getSummarizationRequestAuth(this.model!, signal)),
					signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// 根据目标条目类型确定新的叶节点位置。
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// 用户消息：叶节点设为其父节点（根节点的父节点为 null），消息文本填入编辑器。
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// 自定义消息：叶节点设为其父节点（根节点的父节点为 null），消息文本填入编辑器。
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// 非用户消息：叶节点设为选中的节点。
				newLeafId = targetId;
			}

			// 切换叶节点，可选择是否附带摘要。
			// 摘要会附加在导航目标位置（newLeafId），而不是旧分支上。
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// 在目标位置创建摘要（目标为根节点时可以是 null）。
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// 为摘要条目添加标签。
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// 没有摘要且导航到根节点：重置叶节点。
				this.sessionManager.resetLeaf();
			} else {
				// 没有摘要且导航到非根节点。
				this.sessionManager.branch(newLeafId);
			}

			// 未生成摘要时，直接为目标条目添加标签（没有摘要条目可供标记）。
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// 根据规范会话投影更新已定稿的上下文。
			this._refreshFinalizedContext();
			this._restoreToolsFromTranscript();

			// 发出 session_tree 事件。
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// 向自定义工具发出事件。

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * 获取会话中的所有用户消息，供分叉选择器使用。
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * 获取会话统计信息。汇总所有会话条目（包括已被压缩移除的历史记录），
	 * 因此令牌数和费用总额反映整个会话的实际计费情况。
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this._limitsModel();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// 压缩后，最后一条助手消息的用量反映的是压缩前的上下文大小。
		// 只有最近一次压缩之后回复的助手消息，其用量才可信。
		// 如果不存在这样的消息，在下次 LLM 响应前无法确定上下文令牌数。
		const projection = this.sessionManager.buildSessionProjection();
		const branch = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branch);

		if (latestCompaction) {
			const projectedAssistants = new Set(
				projection.entries.flatMap((entry) =>
					entry.messages.some(
						(message) =>
							message.role === "assistant" &&
							message.stopReason !== "aborted" &&
							message.stopReason !== "error" &&
							calculateContextTokens(message.usage) > 0,
					)
						? [entry.sourceEntry.id]
						: [],
				),
			);
			const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
			const hasPostCompactionUsage = branch
				.slice(compactionIndex + 1)
				.some((entry) => projectedAssistants.has(entry.id));
			if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
		}

		const estimate = estimateProjectedContextTokens(projection, branch);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * 将会话导出为 HTML。
	 * @param outputPath 可选输出路径（默认为会话目录）。
	 * @param options 可选的导出显示设置。
	 * @returns 导出文件的路径。
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// 存在扩展运行器时创建工具渲染器，以支持自定义工具的 HTML 渲染。
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) =>
				this._extensionRunner.resolveToolRenderers(name, () => this.getToolDefinition(name)),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * 将当前会话分支导出为 JSONL 文件。
	 * 文件先写入会话头信息，再写入当前分支路径上的所有条目。
	 * @param outputPath 目标文件路径；省略时会在当前工作目录生成带时间戳的文件。
	 * @returns 解析后的导出文件路径。
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	/**
	 * 请当前模型描述本次会话中出现的问题，以便生成错误报告。
	 * 用户拒绝分享会话记录时使用。
	 */
	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		const model = this.model;
		if (!model) {
			throw new Error("No model selected");
		}
		return generateBugReportSummary({
			...(await this._getSummarizationRequestAuth(model, options.signal)),
			messages: this.messages,
			hint: options.hint,
			signal: options.signal,
			streamFn: this.agent.streamFunction,
			retry: this.settingsManager.getRetrySettings(),
			sessionId: this.sessionId,
		});
	}

	// =========================================================================
	// 通用工具方法。
	// =========================================================================

	/**
	 * 获取最后一条助手消息的文本内容。
	 * 供 /copy 命令使用。
	 * @returns 文本内容；不存在助手消息时返回 undefined。
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// 跳过没有内容的已中止消息。
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// 扩展系统。
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * 检查扩展是否注册了指定事件类型的处理器。
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * 获取扩展运行器（用于设置界面上下文和错误处理器）。
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
