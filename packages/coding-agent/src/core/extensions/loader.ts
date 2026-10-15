/**
 * 扩展加载器：使用 jiti 加载 TypeScript 扩展模块。
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Provider } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import type { createJiti } from "jiti";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary, isBundledNode } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { type McpServerConfig, McpServerRegistry, mcpNamespace, validateMcpServerConfig } from "../mcp-servers.ts";
import { readPiManifest } from "../pi-manifest.ts";
import { createSyntheticSourceInfo, getSyntheticPathSource, isSyntheticPath } from "../source-info.ts";
import { time } from "../timings.ts";
import type { ModelRouteRequest, VirtualModelDefinition } from "../virtual-models.ts";
import type {
	EntryRenderer,
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	ExtensionVirtualModel,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
	ToolRendererResolver,
} from "./types.ts";

const require = createRequire(import.meta.url);

const isNodeSeaBinary =
	("sea" in process.features && process.features.sea === true) ||
	process.getBuiltinModule("node:sea")?.isSea() === true;
const isTypeScriptSourceRuntime = !isBunBinary && path.extname(fileURLToPath(import.meta.url)) === ".ts";
const usesEmbeddedModules = isBunBinary || isNodeSeaBinary || isBundledNode;

let createJitiPromise: Promise<typeof createJiti> | undefined;

function getCreateJiti(): Promise<typeof createJiti> {
	createJitiPromise ??= (usesEmbeddedModules ? import("./jiti-static-loader.ts") : import("./jiti-loader.ts")).then(
		(module) => module.createJiti,
	);
	return createJitiPromise;
}

let virtualModulesPromise: Promise<Record<string, unknown>> | undefined;

function getVirtualModules(): Promise<Record<string, unknown>> {
	virtualModulesPromise ??= import("./virtual-modules.ts").then((module) => module.VIRTUAL_MODULES);
	return virtualModulesPromise;
}

/**
 * 获取供 jiti 使用的别名（用于 Node.js 构建模式）。
 * 在编译后的二进制模式下改用 virtualModules。
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@earendil-works/pi-agent-core");
	const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
	// 扩展将 pi-ai 根路径解析到 compat 入口；该入口严格包含 core 入口的全部能力。
	// 这样，使用旧全局 API 的现有扩展在 compat 移除前仍能正常运行。
	const piAiCompatEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@earendil-works/pi-ai/compat");
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@earendil-works/pi-ai/oauth");
	const piAiProvidersEntry = resolveWorkspaceOrImport(
		"ai/dist/providers/all.js",
		"@earendil-works/pi-ai/providers/all",
	);

	_aliases = {
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		"@earendil-works/pi-ai/providers/all": piAiProvidersEntry,
		"@earendil-works/pi-ai/compat": piAiCompatEntry,
		"@earendil-works/pi-ai/oauth": piAiOauthEntry,
		"@earendil-works/pi-ai": piAiCompatEntry,
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		"@mariozechner/pi-ai/providers/all": piAiProvidersEntry,
		"@mariozechner/pi-ai/compat": piAiCompatEntry,
		"@mariozechner/pi-ai/oauth": piAiOauthEntry,
		"@mariozechner/pi-ai": piAiCompatEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionCache = new Map<string, ExtensionFactory>();

interface ExtensionCacheToken {
	cwd: string;
	generation: number;
}

export function clearExtensionCache(): void {
	extensionCache.clear();
	extensionCacheCwd = undefined;
	extensionCacheGeneration++;
}

function useExtensionCacheCwd(cwd: string): ExtensionCacheToken {
	const resolvedCwd = resolvePath(cwd);
	if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
		clearExtensionCache();
	}
	extensionCacheCwd = resolvedCwd;
	return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}

/**
 * 创建一个运行时，其中的操作方法暂由调用时会抛错的桩函数实现。
 * Runner.bindCore() 会将它们替换为实际实现。
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const eventBusUnsubscribers = new Set<() => void>();
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		getSettings: notInitialized,
		setActiveTools: notInitialized,
		// 扩展加载期间可以调用 registerTool()；只有绑定完成后才需要刷新工具。
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		pendingNativeProviderRegistrations: [],
		mcpServers: new McpServerRegistry(),
		pendingVirtualModelRegistrations: [],
		createContext: notInitialized,
		assertActive,
		invalidate: (message) => {
			if (state.staleMessage) return;
			state.staleMessage =
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
			for (const unsubscribe of eventBusUnsubscribers) unsubscribe();
			eventBusUnsubscribers.clear();
		},
		trackEventBusSubscription: (unsubscribe) => {
			let active = true;
			const trackedUnsubscribe = () => {
				if (!active) return;
				active = false;
				eventBusUnsubscribers.delete(trackedUnsubscribe);
				unsubscribe();
			};
			eventBusUnsubscribers.add(trackedUnsubscribe);
			return trackedUnsubscribe;
		},
		// 绑定前先将注册操作排队，待模型注册表可用后由 bindCore() 统一处理。
		// bindCore() 会将这两个方法替换为直接调用。
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		registerNativeProvider: (provider, extensionPath = "<unknown>") => {
			runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
			runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
				(r) => r.provider.id !== name,
			);
		},
		registerVirtualModel: (definition, extensionPath = "<unknown>") => {
			runtime.pendingVirtualModelRegistrations.push({ definition, extensionPath });
		},
		unregisterVirtualModel: (provider, id) => {
			runtime.pendingVirtualModelRegistrations = runtime.pendingVirtualModelRegistrations.filter(
				({ definition }) => definition.provider !== provider || definition.id !== id,
			);
		},
	};

	return runtime;
}

/**
 * 为扩展创建 ExtensionAPI。
 * 注册方法会写入扩展对象；操作方法则委托给共享运行时。
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): { api: ExtensionAPI; commit: () => void; discard: () => void } {
	const pendingFlagValues = new Map<string, boolean | string>();
	const pendingRuntimeChanges: Array<() => void> = [];
	const loadingUnsubscribers: Array<() => void> = [];
	let state: "loading" | "active" | "failed" = "loading";
	const assertActive = () => {
		if (state === "failed") {
			throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
		}
		runtime.assertActive();
	};
	const applyRuntimeChange = (change: () => void) => {
		if (state === "loading") pendingRuntimeChanges.push(change);
		else change();
	};
	const clearPending = () => {
		pendingFlagValues.clear();
		pendingRuntimeChanges.length = 0;
		loadingUnsubscribers.length = 0;
	};

	const api = {
		// 注册方法：写入扩展对象。
		on(event: string, handler: HandlerFn): () => void {
			assertActive();
			const registeredHandler: HandlerFn = (...args) => handler(...args);
			const list = extension.handlers.get(event) ?? [];
			list.push(registeredHandler);
			extension.handlers.set(event, list);

			return () => {
				const handlers = extension.handlers.get(event);
				if (!handlers) return;
				const handlerIndex = handlers.indexOf(registeredHandler);
				if (handlerIndex === -1) return;
				handlers.splice(handlerIndex, 1);
				if (handlers.length === 0) extension.handlers.delete(event);
			};
		},

		registerTool(tool: ToolDefinition): void {
			assertActive();
			if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
				throw new Error(
					`Tool "${tool.name}" registered by extension "${extension.path}" must define an object parameter schema.`,
				);
			}
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			assertActive();
			if (typeof name !== "string" || name.length === 0) {
				throw new Error(
					`Command registered by extension "${extension.path}" must have a non-empty string name. Use pi.registerCommand("name", { description, handler }).`,
				);
			}
			if (typeof options?.handler !== "function") {
				throw new Error(`Command "/${name}" registered by extension "${extension.path}" must define handler().`);
			}
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
		): void {
			assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			assertActive();
			if (options.default !== undefined && typeof options.default !== options.type) {
				throw new Error(
					`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`,
				);
			}
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				if (state === "loading") {
					if (!pendingFlagValues.has(name)) pendingFlagValues.set(name, options.default);
				} else {
					runtime.flagValues.set(name, options.default);
				}
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerMarkdownTransformer(transformer: MarkdownTransformer): void {
			assertActive();
			extension.markdownTransformer = transformer;
		},

		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			assertActive();
			extension.entryRenderers ??= new Map();
			extension.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		registerToolRenderer(resolver: ToolRendererResolver): void {
			assertActive();
			extension.toolRenderers ??= [];
			extension.toolRenderers.push(resolver);
		},

		// 标志访问：检查扩展是否注册该标志，并从运行时读取其值。
		getFlag(name: string): boolean | string | undefined {
			assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlagValues.get(name);
		},

		// 操作方法：委托给共享运行时。
		sendMessage(message, options): void {
			assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			assertActive();
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			assertActive();
			return runtime.getAllTools();
		},

		getSettings() {
			assertActive();
			return runtime.getSettings();
		},

		setActiveTools(toolNames: string[]): void {
			assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			assertActive();
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("Provider config is required when registering by name");
				applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, extension.path));
				return;
			}
			applyRuntimeChange(() => runtime.registerNativeProvider(providerOrName, extension.path));
		},

		unregisterProvider(name: string) {
			assertActive();
			applyRuntimeChange(() => runtime.unregisterProvider(name, extension.path));
		},

		registerMcpServer(name: string, config: McpServerConfig) {
			assertActive();
			const validated = validateMcpServerConfig(name, config);
			if (typeof validated === "string") {
				throw new Error(`Invalid MCP server registered by extension "${extension.path}": ${validated}`);
			}
			const owner = runtime.mcpServers.get(name)?.extensionPath;
			if (owner !== undefined && owner !== extension.path) {
				throw new Error(`MCP server "${name}" is already registered by extension "${owner}"`);
			}
			// 仅 `-` 和 `_` 不同的名称会处于同一命名空间。
			const clash = runtime.mcpServers
				.list()
				.find((server) => server.name !== name && mcpNamespace(server.name) === mcpNamespace(name));
			if (clash) throw new Error(`MCP server "${name}" conflicts with registered server "${clash.name}"`);
			const server = { name, config: structuredClone(validated), extensionPath: extension.path };
			applyRuntimeChange(() => runtime.mcpServers.register(server));
		},

		unregisterMcpServer(name: string) {
			assertActive();
			applyRuntimeChange(() => runtime.mcpServers.unregister(name, extension.path));
		},

		getMcpServers() {
			assertActive();
			return runtime.mcpServers.list();
		},

		registerVirtualModel<TState>(model: ExtensionVirtualModel<TState>) {
			assertActive();
			// 路由会在 runner 绑定后运行，因此每个请求都会创建新的 context。状态取自此路由器写入的会话分支。
			const definition: VirtualModelDefinition = {
				...model,
				route: (request) => model.route(request as ModelRouteRequest<TState>, runtime.createContext()),
			};
			applyRuntimeChange(() => runtime.registerVirtualModel(definition, extension.path));
		},

		unregisterVirtualModel(provider: string, id: string) {
			assertActive();
			applyRuntimeChange(() => runtime.unregisterVirtualModel(provider, id));
		},

		events: {
			emit(channel, data) {
				assertActive();
				eventBus.emit(channel, data);
			},
			on(channel, handler) {
				assertActive();
				const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
				if (state === "loading") loadingUnsubscribers.push(unsubscribe);
				return unsubscribe;
			},
		},
	} as ExtensionAPI;

	return {
		api,
		commit: () => {
			if (state !== "loading") return;
			runtime.assertActive();
			for (const [name, value] of pendingFlagValues) {
				if (!runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
			}
			for (const apply of pendingRuntimeChanges) apply();
			state = "active";
			clearPending();
		},
		discard: () => {
			if (state !== "loading") return;
			state = "failed";
			for (const unsubscribe of loadingUnsubscribers) unsubscribe();
			clearPending();
		},
	};
}

function isCurrentCacheToken(cacheToken: ExtensionCacheToken | undefined): cacheToken is ExtensionCacheToken {
	return (
		cacheToken !== undefined &&
		extensionCacheCwd === cacheToken.cwd &&
		extensionCacheGeneration === cacheToken.generation
	);
}

async function loadExtensionModule(extensionPath: string, cacheToken?: ExtensionCacheToken) {
	if (isCurrentCacheToken(cacheToken)) {
		const cachedFactory = extensionCache.get(extensionPath);
		if (cachedFactory) {
			return cachedFactory;
		}
	}

	const createJitiImpl = await getCreateJiti();
	// 编译后的二进制文件和打包的 Node 发行版使用嵌入模块。
	// TypeScript 源码复用宿主模块和根目录 tsconfig 路径配置；未打包的 Node 构建使用 dist 别名，
	// 不需要打包版本中的虚拟模块。
	const resolutionOptions = usesEmbeddedModules
		? { virtualModules: await getVirtualModules(), tryNative: false }
		: isTypeScriptSourceRuntime
			? { virtualModules: await getVirtualModules(), tsconfigPaths: true }
			: { alias: getAliases() };
	const jiti = createJitiImpl(import.meta.url, {
		moduleCache: false,
		...resolutionOptions,
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	if (typeof factory !== "function") {
		return undefined;
	}
	if (isCurrentCacheToken(cacheToken)) {
		extensionCache.set(extensionPath, factory);
	}
	return factory;
}

/**
 * 创建一个集合均为空的 Extension 对象。
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source = getSyntheticPathSource(extensionPath) ?? "local";
	const baseDir = isSyntheticPath(extensionPath) ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function initializeExtension(
	factory: ExtensionFactory,
	extensionPath: string,
	resolvedPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<Extension> {
	const extension = createExtension(extensionPath, resolvedPath);
	const load = createExtensionAPI(extension, runtime, cwd, eventBus);
	try {
		await factory(load.api);
		load.commit();
	} catch (error) {
		load.discard();
		throw error;
	}
	time(`${extensionPath} factory`, "extensions");
	return extension;
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const factory = await loadExtensionModule(resolvedPath, cacheToken);
		time(`${extensionPath} module import`, "extensions");
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = await initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * 根据内联工厂函数创建 Extension。
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const resolvedCwd = resolvePath(cwd);
	return initializeExtension(factory, extensionPath, extensionPath, resolvedCwd, eventBus, runtime);
}

/**
 * 从指定路径加载扩展。
 */
async function loadExtensionsInternal(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	useCache = false,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const warnings: Array<{ path: string; warning: string }> = [];
	const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
	const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const resolvedRuntime = runtime ?? createExtensionRuntime();

	for (const extPath of paths) {
		const { extension, error } = await loadExtension(
			extPath,
			resolvedCwd,
			resolvedEventBus,
			resolvedRuntime,
			cacheToken,
		);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		warnings,
		runtime: resolvedRuntime,
	};
}

export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime);
}

export async function loadExtensionsCached(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime, true);
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * 解析目录中的扩展入口。
 *
 * 检查以下入口：
 * 1. package.json 中的 "pi.extensions" 字段：返回声明的路径
 * 2. index.ts 或 index.js：返回对应索引文件
 *
 * 返回解析出的路径；未找到入口时返回 null。
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// 优先检查 package.json 中的 "pi" 字段。
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// 检查 index.ts 或 index.js。
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * 在目录中发现扩展。
 *
 * 发现规则：
 * 1. 加载扩展目录中的直接 TypeScript 或 JavaScript 文件。
 * 2. 加载包含索引文件的一级子目录。
 * 3. 对于包含 package.json 的子目录，若其中声明了 "pi" 字段，则加载对应入口。
 *
 * 最多只向下扫描一层。复杂的软件包必须使用 package.json 清单声明入口。
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. 直接文件：*.ts 或 *.js。
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 和 3. 子目录。
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * 从标准位置发现并加载扩展。
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. 项目本地扩展：cwd/配置目录名/extensions/
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. 全局扩展：agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. 显式配置的路径。
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// 检查含有 pi 清单的 package.json 或 index.ts。
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// 未声明明确入口：发现目录中的独立文件。
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, resolvedCwd, eventBus);
}
