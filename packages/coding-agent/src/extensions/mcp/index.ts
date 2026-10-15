/**
 * 内置 MCP 集成。
 *
 * 在会话启动时连接 `mcp.json` 中的服务器以及 extension 通过 `pi.registerMcpServer()` 注册的服务器，
 * 之后注册的服务器则立即连接。`mcp.json` 中的服务器优先于同名注册服务器。连接在后台运行：第一个
 * 提示只等待带 `direct` 工具的服务器，而 codemode 脚本、`tool_search` 和资源工具在运行时等待它们
 * 需要的服务器。工具以 `mcp__<server>__<tool>` 的形式注册。默认情况下（`"exposure": "codemode"`）
 * 工具只能从 codemode 脚本调用，这让 MCP 工具不进入模型的 tool declaration 和 codemode 描述：
 * 脚本用 `searchTools()` 查找工具，用 `describeNamespace()` 查看服务器说明。codemode 工具会据此
 * 自动激活，除非 `autoEnableCodemode` 为 false。`"deferred"` 在 `tool_search` 工具加载它们之后
 * 才向模型声明，并激活 `tool_search` 而非 codemode。
 * `"exposure": "direct"` 立即向模型声明工具，`"hidden"` 则让它们不可达。`toolExposure` 可覆盖
 * 单个工具的 exposure。带资源的服务器通过 Codex 的 `list_mcp_resources`、
 * `list_mcp_resource_templates` 和 `read_mcp_resource` 工具访问（resources.ts）。
 *
 * 每次调用都会经过 pi 的 tool pipeline，因此 `tool_call`/`tool_result` 钩子和权限 extension
 * 对 MCP 工具的作用方式与对内置工具完全相同。
 *
 * 启动时发现的问题（配置错误、连接失败、需要登录的服务器）只报告一次。`/mcp` 打开一个管理器，
 * 可用于登录、重连、启用或禁用服务器以及修改 exposure；后两者会保存到定义该服务器的 `mcp.json`，
 * 对注册服务器则只作用于当前会话。
 */

import { join, resolve } from "node:path";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import { mcpNamespace } from "../../core/mcp-servers.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { CODEMODE_TOOL_NAME, isCodemodeTool } from "../codemode/tool.ts";
import { isToolSearchTool, TOOL_SEARCH_TOOL_NAME } from "../tool-search/tool.ts";
import {
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	updateMcpServerConfig,
} from "./config.ts";
import type { McpOAuthCredentialStore, McpSignInPrompt } from "./oauth.ts";
import {
	createMcpResourceToolDefinitions,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	READ_MCP_RESOURCE_TOOL,
} from "./resources.ts";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import type * as McpRuntime from "./runtime.ts";
import type { McpServerConnection, McpServerLog, McpTransportFactory } from "./runtime.ts";
import { createMcpToolDefinition, createMcpToolName, createMcpToolRenderers, type McpToolDetails } from "./tools.ts";
import { type McpMenu, type McpUi, showMcpManager } from "./ui.ts";

export type { McpTransportFactory } from "./runtime.ts";

export interface McpExtensionOptions {
	/** 默认从 agent 目录和受信任项目读取 `mcp.json`。 */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
	/** 默认使用由服务器配置构建的 stdio 和 streamable HTTP 传输。 */
	createTransport?: McpTransportFactory;
	/** 默认使用 agent 目录下的 `mcp-auth.json`。 */
	credentials?: McpOAuthCredentialStore;
	/** 服务器日志消息追加到的文件。默认为 agent 目录下的 `mcp.log`。 */
	logPath?: string;
	/** 打开 OAuth 授权 URL。默认使用平台浏览器。 */
	openUrl?: (url: string) => void;
	/**
	 * 把 `/mcp` 的修改保存到服务器的配置文件：若设置了项目的 `override` 则存那里，否则存其
	 * `source`。默认编辑对应的 `mcp.json`。
	 */
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
	/**
	 * 第一个提示等待启动时仍在连接中的 `direct` 工具服务器的时长，单位毫秒。
	 * 它们的工具在连接完成后变得可用。其他服务器则在脚本或搜索需要时等待。
	 * 默认：10000。
	 */
	startupWaitMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;

const RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
	LIST_MCP_RESOURCES_TOOL,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	READ_MCP_RESOURCE_TOOL,
]);

/** 一个已配置的服务器。禁用的服务器没有连接。 */
interface McpServer {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	/** 对 extension 注册的服务器：注册时的配置，用于检测重复注册。 */
	registeredConfig?: string;
	/** 最近一次失败的 `/mcp` 操作的结果，显示在管理器中。 */
	message?: string;
	/** 标识当前的连接尝试；禁用或替换服务器会使早先的工作失效。 */
	attempt?: symbol;
	/** 当为该服务器启动的连接完成（成功或失败）时 settle。 */
	ready?: Promise<void>;
	/** 已脱离连接的清理；替代连接在打开传输之前会等待它。 */
	closing?: Promise<void>;
}

const EXPOSURE_DESCRIPTIONS: Record<Exclude<McpExposure, "hidden">, string> = {
	codemode: "called from codemode scripts, which find them with searchTools()",
	deferred: "not declared until tool_search loads them, then called directly; no codemode needed",
	direct: "declared to the model like built-in tools",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

function isEnabled(server: Pick<McpServer, "entry">): boolean {
	return server.entry.config.enabled !== false;
}

function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? "codemode";
}

/** 服务器工具可以处于的 exposure，在连接之前即可从其配置得知。 */
function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
	return new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})]);
}

/** 服务器的部分工具是否向模型声明，第一个提示是否需要等待它们。 */
function hasDirectTools(entry: McpServerEntry): boolean {
	return configuredExposures(entry).has("direct");
}

/** 服务器的部分工具是否通过 codemode 或 tool_search 访问。 */
function hasIndirectTools(entry: McpServerEntry): boolean {
	const exposures = configuredExposures(entry);
	return exposures.has("codemode") || exposures.has("deferred");
}

/** 系统提示中列出其工具未声明的服务器的分区名称。 */
export const MCP_SERVERS_SECTION = "mcp_servers";
/** 分区中每个服务器描述的字符数上限，与 Codex 对 deferred namespace 的限制一致。 */
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/**
 * 整个分区的字符数上限。描述会被压缩以适配；当只算服务器行就已放不下时，
 * 排在最后的服务器会被省略并在结尾一行中计数。
 */
export const MAX_SERVERS_SECTION_CHARS = 4096;

/** 分区的第一行。它只解释所列服务器实际使用的工具访问方式。 */
function serversSectionIntro(reaches: ReadonlySet<string>): string {
	let intro = "MCP servers whose tools are not declared to you.";
	if (reaches.has("codemode")) intro += " Call the tools of `codemode` servers from codemode scripts.";
	if (reaches.has("tool_search")) intro += " Load the tools of `tool_search` servers with `tool_search`.";
	return intro;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `mcp_servers` 分区对一台服务器的所需信息。 */
export interface McpServerListing {
	entry: McpServerEntry;
	connection?: { instructions?: string };
}

/** 配置描述的第一行；已连接后则取服务器说明的第一行。 */
function serverSummary(server: McpServerListing): string {
	const text = server.entry.config.description?.trim() || server.connection?.instructions || "";
	return (text.split("\n", 1)[0] ?? "").trim();
}

/**
 * `mcp_servers` 分区：每个带 codemode 或 deferred 工具的已启用服务器，附其工具的访问方式
 * 与一行摘要。模型由此得知这些服务器的存在，因为 codemode 和 tool_search 都不会列出它们。
 * 没有这类服务器时为 undefined。
 */
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	const listed = servers
		.filter((server) => isEnabled(server) && hasIndirectTools(server.entry))
		.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
	if (listed.length === 0) return undefined;
	const reaches = listed.map((server) =>
		configuredExposures(server.entry).has("codemode") ? "codemode" : "tool_search",
	);
	const intro = serversSectionIntro(new Set(reaches));
	const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`] : [];
	// intro、前 `kept` 行不带描述的服务器行、以及省略行的字符总数。
	const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	// 每条描述还要占一个 ": " 分隔符。
	const perServer =
		kept === 0
			? 0
			: Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
	const lines = listed.slice(0, kept).map((server, index) => {
		const summary = perServer > 0 ? truncate(serverSummary(server), perServer) : "";
		return summary ? `${heads[index]}: ${summary}` : heads[index];
	});
	return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
}

/**
 * codemode 脚本是否需要该服务器：脚本点名了该服务器的 namespace，或者进行了搜索、
 * 枚举或描述工具/namespace 的操作——这些可能以其他形式提到该服务器。
 */
function scriptNeedsServer(code: string, server: string): boolean {
	if (/\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/.test(code)) return true;
	return code.includes(mcpNamespace(server));
}

/** 供列表和启动报告使用的简短状态。`withError` 会附加失败信息的第一行。 */
function describeState(server: McpServer, withError = true): string {
	if (!isEnabled(server)) return "disabled";
	const connection = server.connection;
	if (!connection) return "starting";
	switch (connection.state) {
		case "needs-auth":
			return "needs sign-in";
		case "failed":
			return withError ? `failed: ${firstLine(connection.error ?? "unknown error")}` : "failed";
		case "connected": {
			const { tools, resources } = connection;
			const count = resources.length;
			const resourceCount = count > 0 ? ` · ${count} resource${count === 1 ? "" : "s"}` : "";
			return `connected · ${tools.length} tool${tools.length === 1 ? "" : "s"}${resourceCount}`;
		}
		case "connecting":
			return "connecting…";
		default:
			return connection.state;
	}
}

/** 需要用户先处理的服务器。 */
function attentionRank(server: McpServer): number {
	if (!isEnabled(server)) return 5;
	switch (server.connection?.state) {
		case "needs-auth":
			return 0;
		case "failed":
			return 1;
		case "disconnected":
			return 2;
		case "connected":
			return 4;
		default:
			return 3;
	}
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	if ("url" in config) return config.url;
	return [config.command, ...(config.args ?? [])].join(" ");
}

const MCP_USAGE = "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let servers: McpServer[] = [];
		/** 来自 `mcp.json` 的服务器，优先于同名的注册服务器。 */
		let configuredEntries: McpServerEntry[] = [];
		let configErrors: string[] = [];
		/** 受信任项目的 `mcp.json`，`/mcp` 把全局服务器的项目级覆盖保存在此。 */
		let projectConfig: string | undefined;
		/** 被 `mcp.json` 覆盖的注册服务器，显示在 `/mcp` 中。 */
		let overridden: string[] = [];
		let autoEnableCodemode = true;
		/** 自会话开始以来是否已显示过 "codemode 工具不可达" 的警告。 */
		let warnedUnreachable = false;
		let pending: Promise<unknown> | undefined;
		/** 自会话开始以来是否已有提示等待过启动中的连接。 */
		let waitedForStartup = false;
		const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		/** 会话的工作目录，供 stdio 服务器使用。 */
		let sessionCwd = process.cwd();
		let credentials = options.credentials;
		/** 会话的模型注册表，用于解析 `auth.provider` token。 */
		let modelRegistry: ModelRegistry | undefined;
		let serverLog: McpServerLog | undefined;
		const openUrl = options.openUrl ?? openBrowser;
		const updateConfig =
			options.updateConfig ??
			((entry, patch) =>
				updateMcpServerConfig(entry.override ?? entry.source, entry.name, patch, {
					override: entry.override !== undefined,
				}));

		/**
		 * 当前会话的生命周期：在 session_shutdown 时中止，且在第一个 session_start 之前
		 * （此前的注册会在 session_start 时读取）就处于中止态。工作在启动时会捕获
		 * `session.signal`，一旦该 signal 已中止就丢弃迟到结果，例如在关机后才 resolve 的
		 * runtime 加载。比启动它的命令存续更久的工作同样会随 signal 停止，并用 `track`
		 * 注册，让关机能够等待其清理完成。
		 */
		let session = new AbortController();
		session.abort();
		/** 用 `track` 注册的工作：管理器操作打开或关闭连接，以及登录。 */
		const backgroundActions = new Set<Promise<void>>();
		const track = <T>(work: Promise<T>): Promise<T> => {
			const task = work.then(
				() => undefined,
				() => undefined,
			);
			backgroundActions.add(task);
			void task.finally(() => backgroundActions.delete(task));
			return work;
		};
		const listeners = new Set<() => void>();
		const emitChange = () => {
			for (const listener of listeners) listener();
		};
		const subscribe = (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		};

		const connections = () => servers.flatMap((server) => (server.connection ? [server.connection] : []));
		const findServer = (name: string) => servers.find((server) => server.entry.name === name);

		/** extension 注册的服务器，不含 `mcp.json` 定义的名字（后者优先）。 */
		const registeredServers = (): { servers: McpServer[]; overridden: string[] } => {
			const registered: McpServer[] = [];
			const overriddenNames: string[] = [];
			for (const { name, config, extensionPath } of pi.getMcpServers()) {
				const configured = configuredEntries.find((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
				if (configured) {
					overriddenNames.push(
						`"${name}" registered by ${extensionPath} is overridden by "${configured.name}" in ${configured.source}`,
					);
					continue;
				}
				registered.push({
					entry: { name, config, source: extensionPath, scope: "extension" },
					registeredConfig: JSON.stringify(config),
				});
			}
			return { servers: registered, overridden: overriddenNames };
		};

		const getCredentials = (runtime: typeof McpRuntime): McpOAuthCredentialStore => {
			credentials ??= new runtime.McpOAuthCredentialStore();
			return credentials;
		};

		const getServerLog = (runtime: typeof McpRuntime): McpServerLog => {
			serverLog ??= new runtime.McpServerLog(options.logPath ?? join(getAgentDir(), "mcp.log"));
			return serverLog;
		};

		/** pi 工具名到它被分配的 `<server>\0<tool>` 的映射，保证名字唯一且稳定。 */
		const toolOwners = new Map<string, string>();
		/** 每个服务器当前提供的工具名。 */
		const serverTools = new Map<string, Set<string>>();
		/** 每个工具名最近注册的定义，用于把被撤回的工具重新注册为 hidden。 */
		const definitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();

		// 恢复的会话可能在其服务器连上之前（甚至永远连不上）就要渲染对 MCP 工具的调用。
		pi.registerToolRenderer((toolName, next) => {
			const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
			return next() ?? (match ? createMcpToolRenderers(`${match[1]}/${match[2]}`) : undefined);
		});

		const registerTools = (connection: McpServerConnection) => {
			const server = connection.entry.name;
			const entry = findServer(server)?.entry ?? connection.entry;
			const description = entry.config.description?.trim();
			const namespace = {
				name: mcpNamespace(server),
				...(description ? { description } : {}),
				...(connection.instructions ? { instructions: connection.instructions } : {}),
			};
			const previous = serverTools.get(server) ?? new Set<string>();
			const current = new Set<string>();
			// 与 Codex 一样，所有 sanitize 后同名的工具都会加上 hash 后缀，这样哪个工具
			// 保留原名就不取决于列表的顺序。
			const plain = [...new Set(connection.tools.map((tool) => tool.name))].map((tool) =>
				createMcpToolName(server, tool),
			);
			const assignName = (tool: string, owner: string) => {
				const name = createMcpToolName(server, tool, (candidate) => {
					const existing = toolOwners.get(candidate);
					return (
						(existing !== undefined && existing !== owner) ||
						current.has(candidate) ||
						plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
					);
				});
				toolOwners.set(name, owner);
				current.add(name);
				return name;
			};
			for (const tool of connection.tools) {
				const definition = createMcpToolDefinition({
					server,
					tool,
					name: assignName(tool.name, `${server}\0${tool.name}`),
					exposure: getMcpToolExposure(entry.config, tool.name),
					namespace,
					timeoutMs: connection.timeoutMs,
					getClient: async () => {
						// 已准备好的调用可能比该定义所属的连接活得久，因为就绪钩子还在等待
						// 禁用/重新启用。在执行时才解析替代连接。
						const current = findServer(server);
						if (!current || !isEnabled(current)) throw new Error(`MCP server "${server}" is disabled.`);
						const client = current.connection;
						if (!client) throw new Error(`MCP server "${server}" is still starting.`);
						if (
							getMcpToolExposure(current.entry.config, tool.name) === "hidden" ||
							(client.state === "connected" && !client.tools.some((offered) => offered.name === tool.name))
						) {
							throw new Error(`MCP tool "${server}/${tool.name}" is no longer available.`);
						}
						return client;
					},
					readableResources: () => resourceServers().some((current) => current.name === server),
				});
				definitions.set(definition.name, definition);
				pi.registerTool(definition);
			}
			serverTools.set(server, current);
			// 工具无法注销，因此服务器撤回的工具会被重新注册为 hidden。当服务器再次
			// 提供它们时，会在上方按其配置的 exposure 注册。
			for (const name of previous) {
				const definition = definitions.get(name);
				if (!current.has(name) && definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			syncResourceTools();
		};

		/** 让已禁用服务器的工具不可达。 */
		const hideTools = (server: string) => {
			for (const name of serverTools.get(server) ?? []) {
				const definition = definitions.get(name);
				if (definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			serverTools.set(server, new Set());
			syncResourceTools();
		};

		/** 启用的、带资源且 exposure 不是 `hidden` 的服务器，由资源工具访问。 */
		const serversWithResources = (): McpServer[] =>
			servers.filter(
				(server) => server.connection?.hasResources && isEnabled(server) && exposureOf(server.entry) !== "hidden",
			);
		const resourceServers = (): McpServerConnection[] =>
			serversWithResources().flatMap((server) => (server.connection ? [server.connection] : []));

		/** 资源工具最近一次注册时的 exposure；在任何服务器有资源之前为 undefined。 */
		let resourceToolsExposure: McpExposure | undefined;
		/**
		 * 以资源工具所能访问的服务器中最宽的 exposure 注册资源工具：其中一台是 `direct`
		 * 时就用 `direct`，依此类推。没有任何服务器有资源时保持 hidden。
		 */
		const syncResourceTools = () => {
			const exposures = new Set(serversWithResources().map((server) => exposureOf(server.entry)));
			const exposure = (["direct", "codemode", "deferred"] as const).find((candidate) => exposures.has(candidate));
			const next = exposure ?? "hidden";
			if (next === resourceToolsExposure || (resourceToolsExposure === undefined && next === "hidden")) return;
			const wasDirect = resourceToolsExposure === "direct";
			resourceToolsExposure = next;
			const resourceDefinitions = createMcpResourceToolDefinitions({ exposure: next, servers: resourceServers });
			for (const definition of resourceDefinitions) pi.registerTool(definition);
			if (wasDirect) {
				const names = new Set(resourceDefinitions.map((definition) => definition.name));
				pi.setActiveTools(pi.getActiveTools().filter((name) => !names.has(name)));
			}
		};

		/**
		 * 未向模型声明的工具通过 codemode 工具（脚本调用它们）或 tool_search 工具（它声明
		 * 它们）访问。两者都能访问每一个此类工具。按工具的 exposure 激活对应的工具：
		 * `codemode` 的用 codemode，除非 `autoEnableCodemode` 为 false；`deferred` 的用
		 * tool_search。
		 */
		const ensureDiscoveryActive = (ctx: ExtensionContext) => {
			// 来自配置，因此在服务器连接之前该工具就已激活。资源工具共享其服务器的 exposure。
			const exposures = new Set<McpExposure>();
			for (const server of servers) {
				if (isEnabled(server)) for (const exposure of configuredExposures(server.entry)) exposures.add(exposure);
			}
			const needsCodemode = exposures.has("codemode");
			const needsToolSearch = exposures.has("deferred");
			if (!needsCodemode && !needsToolSearch) return;
			// 其他 extension 的同名工具无法访问 MCP 工具，因此绝不激活它们。
			const tools = pi.getAllTools();
			const hasCodemode = tools.some(isCodemodeTool);
			const hasToolSearch = tools.some(isToolSearchTool);
			const active = pi.getActiveTools();
			const activate: string[] = [];
			if (needsCodemode && hasCodemode && autoEnableCodemode && !active.includes(CODEMODE_TOOL_NAME)) {
				activate.push(CODEMODE_TOOL_NAME);
			}
			if (needsToolSearch && hasToolSearch && !active.includes(TOOL_SEARCH_TOOL_NAME)) {
				activate.push(TOOL_SEARCH_TOOL_NAME);
			}
			if (activate.length > 0) pi.setActiveTools([...active, ...activate]);
			const reachable = [...active, ...activate];
			if (hasCodemode && reachable.includes(CODEMODE_TOOL_NAME)) return;
			if (hasToolSearch && reachable.includes(TOOL_SEARCH_TOOL_NAME)) return;
			if (warnedUnreachable) return;
			warnedUnreachable = true;
			const reason = needsCodemode && hasCodemode && !autoEnableCodemode ? " (autoEnableCodemode is false)" : "";
			ctx.ui.notify(
				`MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
				"warning",
			);
		};

		/**
		 * 等待登录的服务器的已存储 token，即需要登录那一刻的状态。
		 * 其他进程（例如 agent 执行的 `pi mcp login`）中的登录会改变它们。
		 */
		const tokensAtSignIn = new Map<McpServerConnection, string>();
		const storedTokens = (connection: McpServerConnection): string => {
			const url = connection.oauthUrl;
			return url && credentials ? JSON.stringify(credentials.tokens(connection.name, url) ?? null) : "null";
		};
		const onConnectionChange = (connection: McpServerConnection) => {
			if (connection.state !== "needs-auth") tokensAtSignIn.delete(connection);
			else if (!tokensAtSignIn.has(connection)) tokensAtSignIn.set(connection, storedTokens(connection));
			emitChange();
		};
		/** 自凭证被保存以来，重连那些需要登录的服务器。 */
		const reconnectSignedIn = async (ctx: ExtensionContext) => {
			const signedIn = [...tokensAtSignIn].filter(([connection, tokens]) => storedTokens(connection) !== tokens);
			if (signedIn.length === 0) return;
			for (const [connection] of signedIn) tokensAtSignIn.delete(connection);
			await Promise.allSettled(signedIn.map(([connection]) => connection.reconnect()));
			ensureDiscoveryActive(ctx);
		};

		/** 创建服务器连接，首次使用时加载 MCP runtime。 */
		const createConnection = async (
			server: McpServer,
			isCurrent: () => boolean,
		): Promise<McpServerConnection | undefined> => {
			const runtime = await loadMcpRuntime();
			if (!isCurrent()) return undefined;
			const connection = new runtime.McpServerConnection({
				entry: server.entry,
				cwd: sessionCwd,
				createTransport: options.createTransport ?? runtime.createDefaultTransport,
				credentials: getCredentials(runtime),
				providerToken: async (provider) => modelRegistry?.getApiKeyForProvider(provider),
				log: getServerLog(runtime),
				onTools: (connection) => {
					if (isCurrent()) registerTools(connection);
				},
				onChange: (connection) => {
					if (isCurrent()) onConnectionChange(connection);
					else tokensAtSignIn.delete(connection);
				},
			});
			server.connection = connection;
			emitChange();
			return connection;
		};

		/**
		 * 在后台连接服务器。`server.ready` 在其连接成功或失败时 settle；失败会显示在状态中。
		 * 除非期间被禁用、替换或关机，它在 `after` 之后启动。当 MCP runtime 无法加载时，
		 * 返回的 promise 会 reject。
		 */
		const startConnection = (server: McpServer, after?: Promise<unknown>): Promise<void> => {
			const { signal } = session;
			const attempt = Symbol();
			server.attempt = attempt;
			const isCurrent = () =>
				!signal.aborted && server.attempt === attempt && isEnabled(server) && servers.includes(server);
			const ready = (async () => {
				await after;
				if (!isCurrent()) return;
				const connection = await createConnection(server, isCurrent);
				if (!connection || !isCurrent()) return;
				await connection.getClient().catch(() => undefined);
			})();
			server.ready = ready.catch(() => undefined);
			return ready;
		};

		/** 等待最新的连接尝试（包括等待期间排队的），或等待中止。 */
		const waitForServers = async (waiting: readonly McpServer[], signal: AbortSignal | undefined) => {
			for (;;) {
				const ready = waiting.flatMap((server) =>
					isEnabled(server) && servers.includes(server) && server.ready ? [{ server, ready: server.ready }] : [],
				);
				if (ready.length === 0 || signal?.aborted) return;
				let onAbort: (() => void) | undefined;
				await Promise.race([
					Promise.all(ready.map((attempt) => attempt.ready)),
					new Promise<void>((resolve) => {
						onAbort = () => resolve();
						signal?.addEventListener("abort", onAbort, { once: true });
					}),
				]);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				if (
					signal?.aborted ||
					ready.every(
						(attempt) =>
							!isEnabled(attempt.server) ||
							!servers.includes(attempt.server) ||
							attempt.ready === attempt.server.ready,
					)
				)
					return;
			}
		};

		/**
		 * 一条汇总启动后所有需要用户关注事项的消息；传入 `only` 时只报告稍后才连接完成
		 * 的服务器。
		 */
		const reportProblems = (ctx: ExtensionContext, only?: readonly McpServer[]) => {
			const lines = only ? [] : configErrors.map((error) => `config: ${error}`);
			for (const server of only ?? servers) {
				const state = server.connection?.state;
				if (state === "needs-auth" || state === "failed")
					lines.push(`${server.entry.name}: ${describeState(server)}`);
			}
			if (lines.length === 0) return;
			ctx.ui.notify(
				`MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
				"warning",
			);
		};

		/**
		 * 保存配置修改；文件无法更新时返回一条错误消息。对注册服务器的修改只作用于
		 * 当前会话。`inProject` 会添加一个项目级覆盖。
		 */
		const saveConfig = (server: McpServer, patch: McpServerConfigPatch, inProject = false): string | undefined => {
			const override = inProject ? projectConfig : server.entry.override;
			const entry = override ? { ...server.entry, override } : server.entry;
			if (entry.scope !== "extension") {
				try {
					updateConfig(entry, patch);
				} catch (error) {
					return `Could not update ${entry.override ?? entry.source}: ${errorMessage(error)}`;
				}
			}
			server.entry = { ...entry, config: { ...entry.config, ...patch } };
			return undefined;
		};

		/** 登录后重连。失败时返回错误消息。`cancel` 或会话结束会终止登录。 */
		const signIn = async (
			server: McpServer,
			prompt: McpSignInPrompt,
			cancel?: AbortSignal,
		): Promise<string | undefined> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return `MCP server "${server.entry.name}" does not use OAuth.`;
			const runtime = await loadMcpRuntime();
			const signal = cancel ? AbortSignal.any([session.signal, cancel]) : session.signal;
			try {
				await track(
					runtime.signInMcpServer({
						serverUrl: url,
						store: getCredentials(runtime).forServer(server.entry.name, url),
						settings: connection.oauthSettings(),
						challenge: connection.challenge,
						prompt,
						signal,
					}),
				);
			} catch (error) {
				if (error instanceof runtime.McpSignInCancelledError) return "Sign-in cancelled.";
				return `Sign-in failed: ${errorMessage(error)}`;
			}
			// 请求本次登录的 challenge（例如要求更多 scope）已得到响应。
			connection.challenge = undefined;
			try {
				await connection.reconnect();
			} catch (error) {
				return `Signed in, but ${errorMessage(error)}`;
			}
			return undefined;
		};

		const signOut = async (server: McpServer): Promise<boolean> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return false;
			const removed = getCredentials(await loadMcpRuntime()).remove(server.entry.name, url);
			await connection.signOut();
			return removed;
		};

		const reconnect = async (server: McpServer): Promise<string | undefined> => {
			const connection = server.connection;
			if (!connection) return `MCP server "${server.entry.name}" is disabled.`;
			const previous = server.ready;
			const ready = (async () => {
				await previous;
				await connection.reconnect();
			})();
			server.ready = ready.catch(() => undefined);
			try {
				await ready;
				return undefined;
			} catch (error) {
				return errorMessage(error);
			}
		};

		/** 配置无法保存时返回错误消息；连接错误显示在状态中。 */
		const setEnabled = async (
			server: McpServer,
			enabled: boolean,
			inProject = false,
		): Promise<string | undefined> => {
			const failed = saveConfig(server, { enabled }, inProject);
			if (failed) return failed;
			if (!enabled) {
				const connection = server.connection;
				server.attempt = undefined;
				server.connection = undefined;
				if (connection) {
					// 重连可能已在等待传输关闭时分离了旧客户端。仅关闭连接并不会
					// 等待那个重连完成。
					server.closing = Promise.all([connection.close(), server.ready]).then(() => undefined);
				}
				const closing = server.closing;
				hideTools(server.entry.name);
				emitChange();
				try {
					await closing;
				} finally {
					if (server.closing === closing) server.closing = undefined;
				}
				return undefined;
			}
			await startConnection(server, server.closing);
			return undefined;
		};

		const setExposure = (server: McpServer, exposure: McpExposure): string | undefined => {
			const failed = saveConfig(server, { exposure });
			if (failed) return failed;
			if (server.connection?.state === "connected") registerTools(server.connection);
			syncResourceTools();
			// 不再以 direct 暴露的工具移出已声明集合；direct 工具在注册时激活。
			const indirect = new Set(
				pi
					.getAllTools()
					.filter((tool) => tool.exposure !== "direct")
					.map((tool) => tool.name),
			);
			const tools = serverTools.get(server.entry.name) ?? new Set<string>();
			pi.setActiveTools(pi.getActiveTools().filter((name) => !tools.has(name) || !indirect.has(name)));
			emitChange();
			return undefined;
		};

		// ---------------------------------------------------------------------------------------
		// 管理器（TUI 中的 `/mcp`）
		// ---------------------------------------------------------------------------------------

		const notices = () => [
			...configErrors.map((error) => `config: ${error}`),
			...overridden.map((line) => `overridden: ${line}`),
		];

		const serversMenu = (): McpMenu => ({
			title: "MCP servers",
			error: notices().join("\n") || undefined,
			items: [...servers]
				.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
				.map((server) => ({
					value: server.entry.name,
					label: server.entry.name,
					description: `${describeState(server)} · ${exposureOf(server.entry)} · ${server.entry.override ? "global, project override" : (server.entry.scope ?? server.entry.source)}`,
				})),
			empty: `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`,
			confirmLabel: "manage",
			cancelLabel: "close",
		});

		const serverMenu = (name: string): McpMenu => {
			const server = findServer(name);
			if (!server) {
				return {
					title: name,
					items: [],
					empty: "This server is no longer configured.",
					confirmLabel: "",
					cancelLabel: "back",
				};
			}
			const { entry, connection } = server;
			const saved =
				entry.scope === "extension"
					? "for this session"
					: entry.override
						? "saved to the project mcp.json"
						: entry.scope
							? `saved to the ${entry.scope} mcp.json`
							: "saved to mcp.json";
			// 不带覆盖的全局服务器可以单独为受信任项目开启或关闭。
			const inProject = entry.scope === "global" && !entry.override && projectConfig !== undefined;
			const inProjectSaved = "saved to the project mcp.json";
			const items: SelectItem[] = [];
			if (!isEnabled(server)) {
				items.push({ value: "enable", label: "Enable", description: saved });
				if (inProject) {
					items.push({ value: "enable-project", label: "Enable in this project", description: inProjectSaved });
				}
			} else {
				const state = connection?.state;
				if (state === "needs-auth")
					items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
				if (state === "connected" && connection) {
					items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
				}
				if (state === "failed" || state === "disconnected" || state === "connected" || state === "needs-auth") {
					items.push({ value: "reconnect", label: "Reconnect" });
				}
				if (state === "connected" && connection?.oauthUrl) {
					items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
				}
				items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
				items.push({ value: "disable", label: "Disable", description: saved });
				if (inProject) {
					items.push({ value: "disable-project", label: "Disable in this project", description: inProjectSaved });
				}
			}
			const details = [
				describeTransport(entry),
				`${entry.scope ?? "config"}: ${entry.source}`,
				...(entry.override ? [`project override: ${entry.override}`] : []),
				`State: ${describeState(server, false)}`,
			];
			const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			return {
				title: `MCP server ${name}`,
				details: details.join("\n"),
				error: error || undefined,
				items,
				selected: items[0]?.value,
				confirmLabel: "select",
				cancelLabel: "back",
			};
		};

		const showTools = async (ui: McpUi, server: McpServer) => {
			const exposure = exposureOf(server.entry);
			const overridden = Object.keys(server.entry.config.toolExposure ?? {}).length > 0;
			await ui.menu(() => ({
				title: `Tools of ${server.entry.name}`,
				details: `Exposure ${exposure}: ${exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure]}${overridden ? "\nSome tools override it with toolExposure." : ""}`,
				items: (server.connection?.tools ?? []).map((tool) => {
					const toolExposure = getMcpToolExposure(server.entry.config, tool.name);
					const description = firstLine(tool.description ?? "");
					return {
						value: tool.name,
						label: tool.name,
						description: toolExposure === exposure ? description : `[${toolExposure}] ${description}`,
					};
				}),
				empty: "The server offers no tools.",
				confirmLabel: "back",
				cancelLabel: "back",
			}));
		};

		const chooseExposure = async (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const current = exposureOf(server.entry);
			const choice = await ui.menu(() => ({
				title: `Exposure of ${server.entry.name}`,
				details:
					server.entry.scope === "extension"
						? `Applies to this session; the server is registered by ${server.entry.source}.`
						: `Saved to ${server.entry.override ?? server.entry.source}.`,
				items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
					value: exposure,
					label: `${exposure === current ? "✓ " : "  "}${exposure}`,
					description: EXPOSURE_DESCRIPTIONS[exposure],
				})),
				selected: current,
				confirmLabel: "save",
				cancelLabel: "back",
			}));
			if (!choice || choice === current) return undefined;
			return setExposure(server, choice as McpExposure);
		};

		/** 使用管理器视图的登录界面登录，它会展示 URL 并提供复制键，Esc 取消。 */
		const signInWithUi = (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const title = `Sign in to ${server.entry.name}`;
			const cancel = new AbortController();
			const status = (message: string) => ui.status(title, message, () => cancel.abort());
			let authorizationUrl = "";
			status("Contacting the authorization server…");
			return signIn(
				server,
				{
					showAuthorizationUrl: (url) => {
						authorizationUrl = url.href;
						openUrl(url.href);
					},
					promptForRedirectUrl: async (signal) => {
						const value = await ui.redirectUrl(title, authorizationUrl, signal);
						status("Connecting…");
						return value;
					},
				},
				cancel.signal,
			);
		};

		/** 在连接打开或关闭期间保持已订阅的菜单可用。 */
		const runInBackground = (
			ctx: ExtensionContext,
			server: McpServer,
			operation: () => Promise<string | undefined>,
		) => {
			const ready = operation();
			const attempt = server.attempt;
			const { signal } = session;
			const finish = (message: string | undefined) => {
				if (signal.aborted || server.attempt !== attempt || !servers.includes(server)) return;
				server.message = message;
				ensureDiscoveryActive(ctx);
				emitChange();
			};
			void track(ready.then(finish, (error: unknown) => finish(errorMessage(error))));
		};

		const runAction = async (ui: McpUi, ctx: ExtensionContext, server: McpServer, action: string) => {
			const { signal } = session;
			let message: string | undefined;
			switch (action) {
				case "signin":
					message = await signInWithUi(ui, server);
					break;
				case "reconnect":
					// 连接状态和错误信息已经报告了失败，包括需要登录的情况。
					runInBackground(ctx, server, async () => {
						await reconnect(server);
						return undefined;
					});
					break;
				case "signout":
					await signOut(server);
					break;
				case "tools":
					await showTools(ui, server);
					break;
				case "exposure":
					message = await chooseExposure(ui, server);
					break;
				case "enable":
				case "disable":
				case "enable-project":
				case "disable-project": {
					const enable = action.startsWith("enable");
					runInBackground(ctx, server, () => setEnabled(server, enable, action.endsWith("-project")));
					break;
				}
			}
			// 会话在此期间已结束（例如登录过程中），这使 ctx 已过期。
			if (signal.aborted) return;
			server.message = message;
			ensureDiscoveryActive(ctx);
			emitChange();
		};
		const manage = async (ui: McpUi, ctx: ExtensionContext) => {
			for (;;) {
				const name = await ui.menu(serversMenu, subscribe);
				if (!name) return;
				for (;;) {
					const action = await ui.menu(() => serverMenu(name), subscribe);
					const server = findServer(name);
					if (!action || !server) break;
					await runAction(ui, ctx, server, action);
				}
			}
		};

		// ---------------------------------------------------------------------------------------
		// 子命令与纯状态输出（无 TUI）
		// ---------------------------------------------------------------------------------------

		const formatStatus = (): string => {
			if (servers.length === 0 && configErrors.length === 0 && overridden.length === 0) {
				return `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or .pi/mcp.json.`;
			}
			const lines = servers.map((server) => {
				const { name } = server.entry;
				const exposure = exposureOf(server.entry);
				const connection = server.connection;
				if (connection?.state === "needs-auth")
					return `${name}: needs sign-in, run /mcp login ${name} (${exposure})`;
				const tools = connection?.state === "connected" ? `, ${connection.tools.length} tools` : "";
				const state = !isEnabled(server)
					? "disabled"
					: connection?.state === "disconnected"
						? "disconnected, reconnects on next call"
						: (connection?.state ?? "starting");
				const error =
					connection?.error && connection.state !== "connected"
						? `\n    ${connection.error.split("\n").join("\n    ")}`
						: "";
				return `${name}: ${state}${tools} (${exposure})${error}`;
			});
			for (const error of configErrors) lines.push(`config error: ${error}`);
			for (const line of overridden) lines.push(`overridden: ${line}`);
			return lines.join("\n");
		};

		/** 为子命令解析服务器；省略名字且有歧义时询问用户。 */
		const pickServer = async (
			name: string | undefined,
			ctx: ExtensionCommandContext,
			options: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
		): Promise<McpServer | undefined> => {
			if (name) {
				const server = findServer(name);
				if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
				else if (!options.eligible(server)) ctx.ui.notify(options.none, "error");
				return server && options.eligible(server) ? server : undefined;
			}
			const candidates = servers.filter(options.eligible);
			if (candidates.length === 0) {
				ctx.ui.notify(options.none, "info");
				return undefined;
			}
			const preferred = candidates.filter(options.preferred);
			if (candidates.length === 1) return candidates[0];
			if (preferred.length === 1) return preferred[0];
			const choice = await ctx.ui.select(
				"MCP server",
				candidates.map((server) => server.entry.name),
			);
			return candidates.find((server) => server.entry.name === choice);
		};

		const usesOAuth = (server: McpServer) => server.connection?.oauthUrl !== undefined;
		const oauthPick = {
			eligible: usesOAuth,
			preferred: (server: McpServer) => server.connection?.state === "needs-auth",
			none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
		};

		const loginCommand = async (server: McpServer, ctx: ExtensionCommandContext) => {
			const { name } = server.entry;
			if (!ctx.hasUI) {
				ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
				return;
			}
			const { signal } = session;
			let failure: string | undefined;
			if (ctx.mode === "tui") {
				await showMcpManager(ctx, async (ui) => {
					failure = await signInWithUi(ui, server);
				});
			} else {
				failure = await signIn(server, {
					showAuthorizationUrl: (url) => {
						ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
						openUrl(url.href);
					},
					promptForRedirectUrl: (signal) =>
						ctx.ui.input(
							`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
							"http://127.0.0.1:.../callback?code=...",
							{ signal },
						),
				});
			}
			// 会话在此期间已结束，登录被取消且 ctx 已过期。
			if (signal.aborted) return;
			if (failure) {
				ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
				return;
			}
			ensureDiscoveryActive(ctx);
			ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
		};

		pi.on("session_start", (_event, ctx) => {
			const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx);
			configErrors = loaded.errors;
			projectConfig = loaded.projectConfig;
			autoEnableCodemode = loaded.autoEnableCodemode ?? true;
			warnedUnreachable = false;
			waitedForStartup = false;
			sessionCwd = ctx.cwd;
			modelRegistry = ctx.modelRegistry;
			session = new AbortController();
			const { signal } = session;
			configuredEntries = loaded.servers;
			const registered = registeredServers();
			overridden = registered.overridden;
			servers = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers];
			emitChange();
			// codemode 或 tool_search 依据配置激活：第一个提示不等待工具未向模型声明的
			// 服务器，脚本或搜索需要时再等待。
			ensureDiscoveryActive(ctx);
			const enabled = servers.filter(isEnabled);
			if (enabled.length === 0) {
				reportProblems(ctx);
				return;
			}
			// MCP 客户端此刻才加载，因此没有服务器的会话永远不需要为它买单。等待一个
			// 事件循环轮次让首次渲染发生在加载和连接之前。
			const runtime = new Promise((resolve) => setImmediate(resolve)).then(() => loadMcpRuntime());
			pending = Promise.all(enabled.map((server) => startConnection(server, runtime)))
				.then(() => {
					if (!signal.aborted) reportProblems(ctx);
				})
				.catch((error: unknown) => {
					// 会话可能在此期间已被销毁，这使 ctx 已过期。
					try {
						ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
					} catch {}
				});
		});

		// 第一个提示等待工具已向模型声明的服务器，这样它们能在第一个请求中声明，
		// 但不会无限等待：缓慢或挂起的服务器不得拖住提示。其他服务器则在脚本或
		// 搜索需要时等待（见下）。
		const waitForDirectServers = async (ctx: ExtensionContext) => {
			if (waitedForStartup) return;
			waitedForStartup = true;
			const ready = servers.flatMap((server) =>
				isEnabled(server) && hasDirectTools(server.entry) && server.ready ? [server.ready] : [],
			);
			if (ready.length === 0) return;
			let timer: NodeJS.Timeout | undefined;
			const finished = await Promise.race([
				Promise.all(ready).then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), startupWaitMs);
				}),
			]);
			clearTimeout(timer);
			if (!finished) {
				ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");
			}
		};

		// 每次提示启动时把服务器按当前状态列进 `mcp_servers` 分区。Pi 在分区内容变化时
		// 把它追加到对话中，例如某台服务器连接完成之后。
		pi.on("before_agent_start", async (event, ctx) => {
			await waitForDirectServers(ctx);
			const { sections } = event.systemPromptOptions;
			const section = renderServersSection(servers);
			if (section) sections[MCP_SERVERS_SECTION] = section;
			else delete sections[MCP_SERVERS_SECTION];
		});

		// codemode 脚本会等待它点名服务器，或在其搜索/枚举工具时等待所有服务器，
		// 这样它们的工具会在脚本运行前注册好。tool_search 和资源工具能访问每台服务器，
		// 因此等待所有服务器。直接 MCP 调用只等自己的服务器，包括仍在关闭旧传输的重连。
		pi.on("tool_call", async (event, ctx) => {
			const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
			if (!tool) return;
			// 显示状态仍是 connected 时，就绪可能尚未完成：重连会先关闭旧传输，再打开
			// 新传输。已 settle 的 promise 会立即返回。
			const readyServers = servers.filter((server) => isEnabled(server) && server.ready);
			if (readyServers.length === 0) return;
			let waiting: McpServer[] = [];
			if (isCodemodeTool(tool)) {
				const { code } = event.input as { code?: unknown };
				const source = typeof code === "string" ? code : "";
				waiting = readyServers.filter((server) => scriptNeedsServer(source, server.entry.name));
			} else if (isToolSearchTool(tool) || RESOURCE_TOOL_NAMES.has(tool.name)) {
				waiting = readyServers;
			} else {
				const owner = toolOwners.get(event.toolName)?.split("\0", 1)[0];
				waiting = readyServers.filter((server) => server.entry.name === owner);
			}
			await waitForServers(waiting, ctx.signal);
		});

		// 接收会话之外完成的登录，例如 agent 执行的 `pi mcp login`。
		pi.on("turn_start", async (_event, ctx) => {
			if (tokensAtSignIn.size > 0) await reconnectSignedIn(ctx);
		});

		// 会话期间注册或注销的服务器立即连接或断开。
		pi.on("mcp_servers_change", async (_event, ctx) => {
			const { signal } = session;
			if (signal.aborted) return;
			const registered = registeredServers();
			overridden = registered.overridden;
			const next = new Map(registered.servers.map((server) => [server.entry.name, server]));
			// 已注销的服务器和配置有变化的重注册服务器会被丢弃；后者在下方重新加入。
			const removed = servers.filter(
				(server) =>
					server.entry.scope === "extension" &&
					next.get(server.entry.name)?.registeredConfig !== server.registeredConfig,
			);
			servers = servers.filter((server) => !removed.includes(server));
			for (const server of removed) hideTools(server.entry.name);
			const added = registered.servers.filter((server) => !findServer(server.entry.name));
			servers.push(...added);
			emitChange();
			ensureDiscoveryActive(ctx);
			await Promise.all(removed.map((server) => server.connection?.close()));
			const connecting = added.filter(isEnabled);
			if (signal.aborted || connecting.length === 0) return;
			try {
				await Promise.all(connecting.map((server) => startConnection(server)));
				if (signal.aborted) {
					await Promise.all(connecting.map((server) => server.connection?.close()));
					return;
				}
			} catch (error) {
				ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
				return;
			}
			if (signal.aborted) return;
			reportProblems(ctx, connecting);
		});

		pi.on("session_shutdown", async () => {
			session.abort();
			const closing = connections();
			servers = [];
			emitChange();
			await Promise.all([...backgroundActions, ...closing.map((connection) => connection.close())]);
		});

		pi.registerCommand("mcp", {
			description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
			getArgumentCompletions: (prefix) => {
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return ["login", "logout", "reconnect"]
						.filter((item) => item.startsWith(action ?? ""))
						.map((item) => ({ value: `${item} `, label: item }));
				}
				if (action !== "login" && action !== "logout" && action !== "reconnect") return null;
				const items = servers
					.filter((candidate) =>
						action === "reconnect" ? candidate.connection !== undefined : usesOAuth(candidate),
					)
					.filter((candidate) => candidate.entry.name.startsWith(server))
					.map((candidate) => ({
						value: `${action} ${candidate.entry.name}`,
						label: candidate.entry.name,
						description: describeState(candidate),
					}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === undefined) {
					if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(ui, ctx));
					else {
						await pending;
						ctx.ui.notify(formatStatus(), "info");
					}
					return;
				}
				if (extra.length > 0) {
					ctx.ui.notify(MCP_USAGE, "warning");
					return;
				}
				await pending;
				switch (action) {
					case "login": {
						const server = await pickServer(name, ctx, oauthPick);
						if (server) await loginCommand(server, ctx);
						return;
					}
					case "logout": {
						const server = await pickServer(name, ctx, oauthPick);
						if (!server) return;
						const removed = await signOut(server);
						ctx.ui.notify(
							removed
								? `Signed out of MCP server "${server.entry.name}".`
								: `No stored credentials for MCP server "${server.entry.name}".`,
							"info",
						);
						return;
					}
					case "reconnect": {
						const server = await pickServer(name, ctx, {
							eligible: (candidate) => candidate.connection !== undefined,
							preferred: (candidate) =>
								candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
							none: "No enabled MCP server to reconnect.",
						});
						if (!server) return;
						const failure = await reconnect(server);
						if (failure) ctx.ui.notify(failure, "error");
						else {
							ensureDiscoveryActive(ctx);
							ctx.ui.notify(
								`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`,
								"info",
							);
						}
						return;
					}
					default:
						ctx.ui.notify(MCP_USAGE, "warning");
				}
			},
		});
	};
}

function defaultLoadConfig(ctx: ExtensionContext): LoadedMcpConfig {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
}

export default createMcpExtension();
