import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * 用于测试 AgentSession 运行时的测试框架。
 *
 * 提供以下功能：
 * - 可按声明顺序返回响应的 faux 流函数。
 * - 一次调用即可创建依赖均已连接、使用真实内存实现的 AgentSession。
 * - 捕获事件以供断言使用。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	JsonObject,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { InlineExtension, ResourceLoader } from "../src/index.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "./utilities.ts";

// ============================================================================
// 模拟模型。
// ============================================================================

const FAUX_PROVIDER = "faux";
const FAUX_MODEL_ID = "faux-1";
const FAUX_API = "anthropic-messages" as const;

export const fauxModel: Model<typeof FAUX_API> = {
	id: FAUX_MODEL_ID,
	name: "Faux Model",
	api: FAUX_API,
	provider: FAUX_PROVIDER,
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

// ============================================================================
// 响应描述
// ============================================================================

export interface FauxResponse {
	/** 文本内容块。使用字符串简写时，会转换为单个文本块。 */
	text?: string;
	/** 要包含在响应中的工具调用。 */
	toolCalls?: Array<{ id?: string; name: string; args: JsonObject }>;
	/** 思考内容。 */
	thinking?: string;
	/** 停止原因。默认是 "stop"；若存在 toolCalls，则为 "toolUse"；若设置了 error，则为 "error"。 */
	stopReason?: StopReason;
	/** 错误消息。若未显式设置 stopReason，则会将其设为 "error"。 */
	error?: string;
	/** 用量数值。会与默认值合并（input: 100，output: 50）。 */
	usage?: Partial<Usage>;
	/** 响应开始前的延迟时间，单位为毫秒。 */
	delayMs?: number;
	/** 覆盖模型信息（提供商、模型 ID），使响应看起来像是由其他模型生成。 */
	model?: { provider?: string; id?: string };
}

/** 简写形式：字符串会转换为简单的文本响应。 */
export type FauxResponseInput = FauxResponse | string;

// ============================================================================
// 模拟流式函数
// ============================================================================

function normalizeResponse(input: FauxResponseInput): FauxResponse {
	if (typeof input === "string") {
		return { text: input };
	}
	return input;
}

function buildUsage(partial?: Partial<Usage>): Usage {
	const input = partial?.input ?? 100;
	const output = partial?.output ?? 50;
	const cacheRead = partial?.cacheRead ?? 0;
	const cacheWrite = partial?.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: partial?.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: partial?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

let toolCallIdCounter = 0;

function buildAssistantMessage(resp: FauxResponse): AssistantMessage {
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];

	if (resp.thinking) {
		content.push({ type: "thinking", thinking: resp.thinking });
	}
	if (resp.text !== undefined) {
		content.push({ type: "text", text: resp.text });
	}
	if (resp.toolCalls) {
		for (const tc of resp.toolCalls) {
			content.push({
				type: "toolCall",
				id: tc.id ?? `faux_tc_${++toolCallIdCounter}`,
				name: tc.name,
				arguments: tc.args,
			});
		}
	}

	// 如果完全没有添加内容，则添加空文本
	if (content.length === 0 && !resp.error) {
		content.push({ type: "text", text: "" });
	}

	let stopReason: StopReason;
	if (resp.stopReason) {
		stopReason = resp.stopReason;
	} else if (resp.error) {
		stopReason = "error";
	} else if (resp.toolCalls && resp.toolCalls.length > 0) {
		stopReason = "toolUse";
	} else {
		stopReason = "stop";
	}

	return {
		role: "assistant",
		content,
		api: FAUX_API,
		provider: resp.model?.provider ?? FAUX_PROVIDER,
		model: resp.model?.id ?? FAUX_MODEL_ID,
		usage: buildUsage(resp.usage),
		stopReason,
		errorMessage: resp.error,
		timestamp: Date.now(),
	};
}

// ============================================================================
// 按 token 进行流式输出
// ============================================================================

/** 将字符串拆分为大小不一的片段（3 到 5 个字符），以模拟逐 token 流式输出。 */
function chunkString(text: string): string[] {
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		const size = 3 + Math.floor(Math.random() * 3); // 3, 4, or 5
		chunks.push(text.slice(i, i + size));
		i += size;
	}
	return chunks.length > 0 ? chunks : [""];
}

/**
 * 通过 EventStream 流式发送完整的 AssistantMessage，并为每个内容块生成逼真的中间增量事件。
 */
function streamWithDeltas(stream: AssistantMessageEventStream, message: AssistantMessage): void {
	// 随着内容块流式输出，逐步构建部分响应
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	stream.push({ type: "start", partial: { ...partial } });

	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];

		if (block.type === "thinking") {
			partial.content = [...partial.content, { type: "thinking", thinking: "" }];
			stream.push({ type: "thinking_start", contentIndex: i, partial: { ...partial } });

			for (const chunk of chunkString(block.thinking)) {
				(partial.content[i] as ThinkingContent).thinking += chunk;
				stream.push(makeEvent("thinking_delta", i, chunk, partial));
			}

			stream.push({
				type: "thinking_end",
				contentIndex: i,
				content: block.thinking,
				partial: { ...partial },
			});
		} else if (block.type === "text") {
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex: i, partial: { ...partial } });

			for (const chunk of chunkString(block.text)) {
				(partial.content[i] as TextContent).text += chunk;
				stream.push(makeEvent("text_delta", i, chunk, partial));
			}

			stream.push({
				type: "text_end",
				contentIndex: i,
				content: block.text,
				partial: { ...partial },
			});
		} else if (block.type === "toolCall") {
			const argsJson = JSON.stringify(block.arguments);
			partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
			stream.push({ type: "toolcall_start", contentIndex: i, partial: { ...partial } });

			for (const chunk of chunkString(argsJson)) {
				stream.push(makeEvent("toolcall_delta", i, chunk, partial));
			}

			// 最终工具调用包含实际解析出的参数
			(partial.content[i] as ToolCall).arguments = block.arguments;
			stream.push({
				type: "toolcall_end",
				contentIndex: i,
				toolCall: block,
				partial: { ...partial },
			});
		}
	}

	if (message.stopReason === "pending") {
		const error: AssistantMessage = {
			...message,
			stopReason: "error",
			errorMessage: "Faux response ended without a stop reason",
		};
		stream.push({ type: "error", reason: "error", error });
		return;
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
		return;
	}
	stream.push({ type: "done", reason: message.stopReason, message });
}

function makeEvent(
	type: "text_delta" | "thinking_delta" | "toolcall_delta",
	contentIndex: number,
	delta: string,
	partial: AssistantMessage,
): AssistantMessageEvent {
	return { type, contentIndex, delta, partial: { ...partial } };
}

// ============================================================================
// 流式函数工厂
// ============================================================================

export interface FauxStreamFnState {
	/** 流函数已被调用的次数。 */
	callCount: number;
	/** 按调用顺序记录每次传入的上下文。 */
	contexts: TranscriptContext[];
}

/**
 * 根据一系列响应描述创建 faux 流函数。
 *
 * 函数会按顺序循环使用这些响应。如果调用次数超过响应数量，则从头开始循环。
 *
 * 返回流函数和一个供检查的状态对象。
 */
export function createFauxStreamFn(responses: FauxResponseInput[]): {
	streamFn: (
		model: Model<any>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	state: FauxStreamFnState;
} {
	if (responses.length === 0) {
		throw new Error("createFauxStreamFn requires at least one response");
	}

	const state: FauxStreamFnState = { callCount: 0, contexts: [] };

	const streamFn = (_model: Model<any>, context: TranscriptContext, _options?: SimpleStreamOptions) => {
		const index = state.callCount % responses.length;
		state.callCount++;
		state.contexts.push(context);

		const resp = normalizeResponse(responses[index]);
		const message = buildAssistantMessage(resp);
		const stream = createAssistantMessageEventStream();

		const emit = () => {
			streamWithDeltas(stream, message);
		};

		if (resp.delayMs && resp.delayMs > 0) {
			setTimeout(emit, resp.delayMs);
		} else {
			queueMicrotask(emit);
		}

		return stream;
	};

	return { streamFn, state };
}

// ============================================================================
// 会话测试框架
// ============================================================================

export interface HarnessOptions {
	/** 模拟提供方的响应序列。默认只返回一次 "ok"。 */
	responses?: FauxResponseInput[];
	/** 要使用的模型。默认值：fauxModel。 */
	model?: Model<any>;
	/** 上下文窗口覆盖值（应用到模型）。 */
	contextWindow?: number;
	/** 设置项覆盖值（重试、压缩等）。 */
	settings?: Partial<Settings>;
	/** 系统提示词。默认值为 "You are a test assistant." */
	systemPrompt?: string;
	/** 要注册到智能体的自定义工具。 */
	tools?: AgentTool[];
	/** 基础工具覆盖项（替换内置的 read/bash/edit/write）。 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** 可选的资源加载器覆盖项。 */
	resourceLoader?: ResourceLoader;
	/** 要载入会话资源加载器的内联扩展。 */
	extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
}

export interface Harness {
	session: AgentSession;
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	/** 模拟流函数状态（调用次数、捕获的上下文）。 */
	faux: FauxStreamFnState;
	/** 会话按顺序发出的所有事件。 */
	events: AgentSessionEvent[];
	/** 按类型筛选捕获的事件。 */
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	/** 临时目录（由 cleanup() 清理）。 */
	tempDir: string;
	/** 释放会话并删除临时目录。 */
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

async function createHarnessWithResourceLoader(
	options: HarnessOptions,
	resourceLoader: ResourceLoader,
	tempDir: string,
): Promise<Harness> {
	const baseModel = options.model ?? fauxModel;
	const model: Model<any> = options.contextWindow ? { ...baseModel, contextWindow: options.contextWindow } : baseModel;

	const { streamFn, state: fauxState } = createFauxStreamFn(options.responses ?? ["ok"]);

	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
			tools: options.tools ?? [],
		},
		streamFn: streamFn,
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);

	if (options.settings) {
		settingsManager.applyOverrides(options.settings);
	}

	const authStorage = AuthStorage.inMemory({
		[model.provider]: { type: "api_key", key: "faux-key" },
	});
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		baseToolsOverride: options.baseToolsOverride,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	const cleanup = () => {
		session.dispose();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	};

	return {
		session,
		agent,
		sessionManager,
		settingsManager,
		faux: fauxState,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((e): e is Extract<AgentSessionEvent, { type: T }> => e.type === type);
		},
		tempDir,
		cleanup,
	};
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	if (options.extensionFactories?.length) {
		throw new Error("createHarness does not support extensionFactories. Use createHarnessWithExtensions().");
	}

	const tempDir = createTempDir();
	return await createHarnessWithResourceLoader(options, options.resourceLoader ?? createTestResourceLoader(), tempDir);
}

export async function createHarnessWithExtensions(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const extensionsResult = await createTestExtensionsResult(options.extensionFactories ?? [], tempDir);
	const resourceLoader = options.resourceLoader ?? createTestResourceLoader({ extensionsResult });
	return await createHarnessWithResourceLoader(options, resourceLoader, tempDir);
}
