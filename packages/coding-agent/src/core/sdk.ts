import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { CacheWarmer } from "./cache-warmer.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { createToolNameMatcher } from "./mcp-servers.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import {
	applyToolModifiers,
	DEFAULT_TOOL_NAMES,
	getToolListError,
	isToolModifier,
	SettingsManager,
} from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";
import { getBranchSelection } from "./virtual-models.ts";

// 保留 0.81 之前的回退行为：允许扩展在未提供 streamFn 的情况下构造 Agent 实例，
// 或调用底层 agent loop。Agent 核心保持与提供商无关，自身不导入 pi-ai/compat。
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	/** 用于项目本地发现的工作目录。默认：process.cwd() */
	cwd?: string;
	/** 全局配置目录。默认：~/.pi/agent */
	agentDir?: string;

	/** 规范的 model/auth 运行时。默认为使用 agentDir/auth.json 与 models.json 的运行时。 */
	modelRuntime?: ModelRuntime;

	/** 要使用的模型。默认：来自设置，否则取第一个可用的模型 */
	model?: Model<any>;
	/** 思考级别。默认：来自设置，否则为 'medium'（按模型能力截断） */
	thinkingLevel?: ThinkingLevel;
	/** 可供轮换的模型（交互模式下为 Ctrl+P） */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * 未提供显式 allowlist 时的可选默认工具抑制模式。
	 *
	 * - "all"：初始不启用任何工具
	 * - "builtin"：停用默认的内置工具（read、bash、edit、write），
	 *   但保留扩展/自定义工具
	 */
	noTools?: "all" | "builtin";
	/**
	 * 可选的工具名称或模式 allowlist，其中 `*` 匹配任意字符。
	 *
	 * 省略时，若已配置，pi 会用解析出的 `defaultTools` 设置作为初始选择；否则启用默认
	 * 内置工具（read、bash、edit、write）。除非 `noTools` 改变该默认，扩展/自定义工具
	 * 始终保持启用。提供时，只有匹配的工具被启用。MCP 工具仍会为 codemode 与 tool search
	 * 注册，除非某条目以 `mcp__` 开头——此时只保留匹配的 MCP 工具。空列表与
	 * `noTools: "all"` 一样，也会停用 MCP 工具。
	 *
	 * 仅包含 `+name` 与 `-name` 条目的列表不算 allowlist：它向默认选择添加或从中移除
	 * 工具，行为类似于 `defaultTools` 设置。这些条目使用精确名称。与普通条目混用会抛错。
	 */
	tools?: string[];
	/**
	 * 可选的要停用的工具名称或模式 denylist。同时提供 `tools` 时，在其之后应用，
	 * MCP 工具包括在内。
	 */
	excludeTools?: string[];
	/** 要注册的自定义工具（在内置工具之外）。 */
	customTools?: ToolDefinition[];

	/** 资源加载器。省略时使用 DefaultResourceLoader。 */
	resourceLoader?: ResourceLoader;

	/** 会话管理器。默认：SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** 设置管理器。默认：SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** 供扩展运行时启动使用的 session 启动事件元数据。 */
	sessionStartEvent?: SessionStartEvent;
}

/** createAgentSession 的结果 */
export interface CreateAgentSessionResult {
	/** 创建出的 session */
	session: AgentSession;
	/** 扩展结果（供交互模式下的 UI context 初始化使用） */
	extensionsResult: LoadExtensionsResult;
	/** 若 session 恢复时使用的模型与保存的不同，则给出警告 */
	modelFallbackMessage?: string;
}

// 再导出（Re-exports）

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// 工具工厂（供自定义 cwd 使用）
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

// 辅助函数

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * 以指定选项创建一个 AgentSession。
 *
 * @example
 * ```typescript
 * // 最简示例：使用默认配置
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // 继续上一个会话
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// 检查 session 是否有需要恢复的既有数据
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// assistant 消息记录的是应答所用物理模型的名称，因此虚拟选择只存在于
	// model_change 条目中。
	const sessionModel = getBranchSelection(sessionManager.getBranch(), (provider, modelId) =>
		modelRuntime.getModel(provider, modelId),
	);

	// session 已有数据时，尝试从中恢复模型
	if (!model && hasExistingSession && sessionModel) {
		const restoredModel = modelRuntime.getModel(sessionModel.provider, sessionModel.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${sessionModel.provider}/${sessionModel.modelId}`;
		}
	}

	// 仍未确定模型时，用 findInitialModel（先检查设置的默认值，再检查提供商默认值）
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// session 已有数据时，从中恢复思考级别
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// 回退到按模型覆盖值，然后是全局默认值
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// 按模型能力截断
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const toolListError = options.tools ? getToolListError(options.tools) : undefined;
	if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`);
	const defaultToolNames = options.noTools ? [] : (settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES);
	// 仅含 `+name`/`-name` 条目的 `tools` 列表修改默认选择而不是替换它，行为类似
	// `defaultTools` 设置。
	const toolModifiers = options.tools?.some(isToolModifier) ? options.tools : undefined;
	const selectedToolNames = toolModifiers ? applyToolModifiers(defaultToolNames, toolModifiers) : options.tools;
	const allowedToolNames = toolModifiers
		? options.noTools === "all"
			? selectedToolNames
			: undefined
		: (options.tools ?? (options.noTools === "all" ? [] : undefined));
	const excludedToolNames = options.excludeTools;
	const isExcludedTool = excludedToolNames ? createToolNameMatcher(excludedToolNames) : undefined;
	const initialActiveToolNames = (selectedToolNames ?? defaultToolNames).filter((name) => !isExcludedTool?.(name));

	// 创建 convertToLlm 包装器：blockImages 启用时过滤图片（纵深防御）
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// 动态读取设置，让会话中途的变更立即生效
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// 过滤所有消息中的 ImageContent，替换为文本占位符
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// 对连续的 "Image reading is disabled." 文本去重
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const cacheWarmer = new CacheWarmer(
		modelRuntime,
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		async (event) => extensionRunnerRef.current?.emitCacheWarmingDecision(event) ?? event.action,
	);
	const buildRequestOptions = (
		requestModel: Model<any>,
		options: ModelsSimpleStreamOptions = {},
	): ModelsSimpleStreamOptions => {
		const providerRetrySettings = settingsManager.getProviderRetrySettings();
		const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
		const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
		const headerRunner = extensionRunnerRef.current;
		return {
			...options,
			timeoutMs: options.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
			websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
			maxRetries: options.maxRetries ?? providerRetrySettings.maxRetries,
			maxRetryDelayMs: options.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
			transformHeaders: async (requestHeaders) => {
				const headers = mergeProviderAttributionHeaders(
					requestModel,
					settingsManager,
					options.sessionId,
					requestHeaders,
				);
				return headerRunner?.hasHandlers("before_provider_headers")
					? headerRunner.emitBeforeProviderHeaders(headers ?? {})
					: (headers ?? {});
			},
		};
	};
	// 只为选中模型的请求预热。经虚拟选择路由、或被扩展重定向的请求，下一次请求未必重复发送，
	// 预热它们可能是浪费。
	const cacheContextIsCurrent = (requestModel: Model<any>) => {
		const messages = agent.state.messages;
		return () => {
			const currentModel = agent.state.model;
			const currentMessages = agent.state.messages;
			return (
				currentModel.provider === requestModel.provider &&
				currentModel.id === requestModel.id &&
				messages.length <= currentMessages.length &&
				messages.every((message, index) => currentMessages[index] === message)
			);
		};
	};
	const transformProviderPayload = async (payload: unknown) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("before_provider_request")) return payload;
		return runner.emitBeforeProviderRequest(payload);
	};
	const handleProviderResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("after_provider_response")) return;
		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};
	const handleProviderStreamEvent: NonNullable<ModelsSimpleStreamOptions["onProviderStreamEvent"]> = async (
		data,
		model,
	) => {
		const runner = extensionRunnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;
		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
			messages: existingSession.messages,
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const requestOptions = buildRequestOptions(model, options);
			// Compaction 与 summary 使用各自的 routing id；只有 session 请求会替换缓存条目，
			// 因此预热会从它们重新开始。只要当前 transcript 仍在扩展该请求的前缀，就继续预热。
			// Agent 状态可能会浅拷贝 messages 数组、或在不改变提供商请求的情况下刷新 model
			// 对象，所以顶层对象身份不是有效的缓存键。
			if (options?.sessionId === sessionManager.getSessionId()) {
				cacheWarmer.start({ model, context, options: requestOptions }, cacheContextIsCurrent(model));
			}
			return modelRuntime.streamSimple(model, context, requestOptions);
		},
		onPayload: transformProviderPayload,
		onResponse: handleProviderResponse,
		onProviderStreamEvent: handleProviderStreamEvent,
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// 为旧 session 补齐缺失的设置元数据。
	if (hasExistingSession) {
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// 为新 session 保存初始模型与思考级别，以便恢复时还原
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		cacheWarmer,
		initialActiveToolNames,
		usesDefaultTools: (options.tools === undefined || toolModifiers !== undefined) && !options.noTools,
		defaultToolModifiers: toolModifiers,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
	});

	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
