import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * coding-agent 测试共用的辅助工具。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import type {
	Extension,
	ExtensionFactory,
	InlineExtension,
	LoadExtensionsResult,
} from "../src/core/extensions/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodingTools } from "../src/index.ts";

/**
 * 需要身份认证的测试使用此 API 密钥。使用该密钥的测试应包在
 * describe.skipIf(!API_KEY) 中。
 */
export const API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

// ============================================================================
// 从 ~/.pi/agent/auth.json 解析 OAuth API 密钥。
// ============================================================================

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorageData = Record<string, AuthCredential>;

function loadAuthStorage(): AuthStorageData {
	if (!existsSync(AUTH_PATH)) {
		return {};
	}
	try {
		const content = readFileSync(AUTH_PATH, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function saveAuthStorage(storage: AuthStorageData): void {
	const configDir = dirname(AUTH_PATH);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(AUTH_PATH, JSON.stringify(storage, null, 2), "utf-8");
	chmodSync(AUTH_PATH, 0o600);
}

/**
 * 从 ~/.pi/agent/auth.json 中解析指定提供商的 API 密钥。
 *
 * 若凭据类型为 API 密钥，则直接返回密钥。
 * 若凭据类型为 OAuth，则返回访问令牌；令牌过期时会刷新并写回文件。
 *
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	const storage = loadAuthStorage();
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		const oauth = builtinProviders().find((candidate) => candidate.id === provider)?.auth.oauth;
		if (!oauth) return undefined;
		let credential = entry;
		if (Date.now() >= credential.expires) {
			credential = await oauth.refresh(credential, new AbortController().signal);
			storage[provider] = credential;
			saveAuthStorage(storage);
		}
		return (await oauth.toAuth(credential)).apiKey;
	}

	return undefined;
}

/**
 * 检查 ~/.pi/agent/auth.json 中是否包含指定提供商的凭据。
 */
export function hasAuthForProvider(provider: string): boolean {
	const storage = loadAuthStorage();
	return provider in storage;
}

/** pi 智能体真实配置目录的路径。 */
export const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

/**
 * 获取一个以 ~/.pi/agent/auth.json 为后端的 AuthStorage 实例。
 * 需要使用真实 OAuth 凭据的测试应使用此方法。
 */
export function getRealAuthStorage(): AuthStorage {
	return AuthStorage.create(AUTH_PATH);
}

/**
 * 创建用于测试的最简用户消息。
 */
export function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/**
 * 创建用于测试的最简助手消息。
 */
export function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/**
 * 读取会话 JSONL 文件，并为每条记录返回一个标签：消息记录返回消息角色，
 * 其他记录返回其类型（例如 "session"、"model_change"）。
 */
export function readSessionFileRoles(file: string): string[] {
	return readFileSync(file, "utf-8")
		.trim()
		.split("\n")
		.map((line) => {
			const record = JSON.parse(line);
			return record.message?.role ?? record.type;
		});
}

/**
 * 创建测试会话的选项。
 */
export interface TestSessionOptions {
	/** 使用内存会话（不写入文件）。 */
	inMemory?: boolean;
	/** 自定义系统提示词。 */
	systemPrompt?: string;
	/** 自定义设置覆盖项。 */
	settingsOverrides?: Record<string, unknown>;
}

/**
 * createTestSession 返回且需要清理的资源。
 */
export interface TestSessionContext {
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: string;
	cleanup: () => void;
}

export interface CreateTestExtensionsResultInput {
	factory: ExtensionFactory;
	path?: string;
}

type TestExtensionInput = InlineExtension | CreateTestExtensionsResultInput;

export async function createTestExtensionsResult(
	inputs: TestExtensionInput[],
	cwd = process.cwd(),
): Promise<LoadExtensionsResult> {
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions: Extension[] = [];

	for (const [index, input] of inputs.entries()) {
		const isObject = typeof input !== "function";
		const hasName = isObject && "name" in input;
		const hasPath = isObject && "path" in input && typeof input.path === "string" && input.path !== "";
		const factory = isObject ? input.factory : input;
		const extensionPath = hasName ? `<inline:${input.name}>` : hasPath ? input.path : `<inline:${index + 1}>`;

		extensions.push(await loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath));
	}

	return {
		extensions,
		errors: [],
		runtime,
	};
}

export interface CreateTestResourceLoaderOptions {
	extensionsResult?: LoadExtensionsResult;
}

export function createTestResourceLoader(options: CreateTestResourceLoaderOptions = {}): ResourceLoader {
	const extensionsResult = options.extensionsResult ?? {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

/**
 * 创建用于测试的 AgentSession，并完成必要的初始化和清理。
 * 需要真实调用大语言模型的端到端测试应使用此方法。
 */
export async function createTestSession(options: TestSessionOptions = {}): Promise<TestSessionContext> {
	const tempDir = join(tmpdir(), `pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => API_KEY,
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a helpful assistant. Be extremely concise.",
			tools: createCodingTools(process.cwd()),
		},
		streamFn: streamSimple,
	});

	const sessionManager = options.inMemory ? SessionManager.inMemory() : SessionManager.create(tempDir);
	const settingsManager = SettingsManager.create(tempDir, tempDir);

	if (options.settingsOverrides) {
		settingsManager.applyOverrides(options.settingsOverrides);
	}

	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createModelRegistry(authStorage, tempDir);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	// 必须先订阅，才能启用会话持久化。
	session.subscribe(() => {});

	const cleanup = () => {
		session.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	};

	return { session, sessionManager, tempDir, cleanup };
}

/**
 * 使用 SessionManager 构建测试用的会话树。
 * 返回所有已创建条目的 ID。
 *
 * 会话树结构示例：
 * ```
 * u1 -> a1 -> u2 -> a2
 *          -> u3 -> a3  （从 a1 分支）
 * u4 -> a4              (another root)
 * ```
 */
export function buildTestTree(
	session: SessionManager,
	structure: {
		messages: Array<{ role: "user" | "assistant"; text: string; branchFrom?: string }>;
	},
): Map<string, string> {
	const ids = new Map<string, string>();

	for (const msg of structure.messages) {
		if (msg.branchFrom) {
			const branchFromId = ids.get(msg.branchFrom);
			if (!branchFromId) {
				throw new Error(`Cannot branch from unknown entry: ${msg.branchFrom}`);
			}
			session.branch(branchFromId);
		}

		const id =
			msg.role === "user" ? session.appendMessage(userMsg(msg.text)) : session.appendMessage(assistantMsg(msg.text));

		ids.set(msg.text, id);
	}

	return ids;
}
