/**
 * MCP server 配置，以及扩展通过 `pi.registerMcpServer()` 注册的 servers。
 *
 * 核心只负责校验并存储注册项。MCP 扩展（内置的，或另一个处理 `mcp_servers_change` 的扩展）会把它们与
 * `mcp.json` 中的 servers 一起建立连接。
 */

/**
 * 工具名称模式的正则表达式，其中 `*` 匹配任意字符，如 `toolExposure`、`--tools` 与 `--exclude-tools`
 * 所接受的格式。
 */
function toolPatternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

/** 某个工具名是否匹配任一条目；每个条目要么是精确名称，要么是模式。 */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const names = new Set(entries.filter((entry) => !entry.includes("*")));
	const patterns = entries.filter((entry) => entry.includes("*")).map(toolPatternRegExp);
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

/** MCP 资源工具，可以触达每个带资源的 server。 */
export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
	LIST_MCP_RESOURCES_TOOL,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	READ_MCP_RESOURCE_TOOL,
]);

/** 某个工具是否来自 MCP：server 工具（`mcp__<server>__<tool>`）或资源工具。 */
export function isMcpToolName(name: string): boolean {
	return name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(name);
}

/**
 * - `codemode`：工具可从 codemode 脚本调用，但既不向模型声明，也不出现在 codemode 描述里——该描述只列出
 *   server 的命名空间。脚本用 `searchTools()` 找到它们。`codemode-deferred` 作为别名被接受。
 * - `deferred`：在 `tool_search` 工具加载它们之前不向模型声明；此后模型直接调用。不需要 codemode。
 * - `direct`：像其他任何工具一样向模型声明（并可在 codemode 中调用）。
 * - `hidden`：工具已注册，但不可触达。
 */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

const MCP_EXPOSURES: readonly string[] = ["codemode", "deferred", "direct", "hidden"] satisfies McpExposure[];

/** 旧版 exposure 名称，在配置中接受，校验时替换为其现行名称。 */
const MCP_EXPOSURE_ALIASES: Readonly<Record<string, McpExposure>> = { "codemode-deferred": "codemode" };

interface McpServerConfigBase {
	/** 默认：`codemode`。 */
	exposure?: McpExposure;
	/**
	 * 用一句话描述该 server 提供什么。`mcp_servers` 系统提示节会带着它列出该 server，工具搜索按它对 server 的
	 * 工具排序，codemode 的 `describeNamespace()` 也返回它。
	 */
	description?: string;
	/**
	 * 单个工具的 exposure，覆盖 `exposure`。键是 server 提供的工具名，或者是 `*` 匹配任意字符的模式。精确名称
	 * 优先于模式；多个模式之间取对象中第一个命中的。`hidden` 会移除工具，因此 `"exposure": "hidden"` 加上对少量
	 * 工具的覆盖，可以实现只暴露这几个工具。
	 */
	toolExposure?: Record<string, McpExposure>;
	/** 设为 false 表示保留条目但不建立连接。默认：true。 */
	enabled?: boolean;
	/** 每次请求的超时（秒）。server 的进度通知会重置它。默认：60。 */
	timeout?: number;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	/** 值可以引用环境变量（`${NAME}`）或命令（`!cmd`）。 */
	env?: Record<string, string>;
	/** 相对路径基于会话工作目录解析。 */
	cwd?: string;
}

/** 不支持动态客户端注册的服务器所需的 OAuth 客户端设置。 */
/** 面向不支持动态客户端注册的 server 的 OAuth 客户端设置。 */
export interface McpOAuthConfig {
	/** 预注册的 client id。没有它时，pi 会向授权服务器注册一个客户端。 */
	clientId?: string;
	/** 可以引用环境变量（`${NAME}`）或命令（`!cmd`）。 */
	clientSecret?: string;
	/**
	 * 回环（loopback）回调 server 的端口，适用于以固定 redirect URI 注册的客户端。没有 `callbackUrl` 时，
	 * redirect URI 为 `http://127.0.0.1:<port>/callback`。
	 */
	callbackPort?: number;
	/**
	 * 已为 `clientId` 注册的 redirect URI，例如 `http://localhost:8080/oauth/callback`。必须是基于 `localhost`、
	 * `127.0.0.1` 或 `[::1]` 的 `http` URI。未含端口时，回调 server 监听 `callbackPort` 或一个空闲端口，并把该
	 * 端口加进 URI（RFC 8252）。
	 */
	callbackUrl?: string;
	/** 请求的 scope，以空格分隔。默认：server 公告的 scopes。 */
	scope?: string;
	/**
	 * 动态客户端注册时发送的 `client_name`，适用于只接受已知客户端的 server。默认：`pi`。
	 */
	clientName?: string;
	/**
	 * 没有 `clientId` 时 pi 的自标识方式。`dcr`（默认）：动态客户端注册。`cimd`：pi 在 pi.dev 上的 Client ID
	 * Metadata Document，适用于接受按该 URL 识别 pi 的授权服务器。server 必须为公开客户端支持它，且回调必须
	 * 使用默认路径 `/callback`。
	 */
	clientRegistration?: "dcr" | "cimd";
	/**
	 * 授权服务器元数据文档（RFC 8414 或 OpenID Connect discovery），用于替代通过 server 做发现，适用于公告了错误
	 * 授权服务器或完全不公告的 server。该文档按"已配置"对待而直接信任。必须使用 https，回环主机除外。
	 */
	authServerMetadataUrl?: string;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** 某个 redirect URI 能否由 pi 的回环回调 server 提供服务。 */
export function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	/** 值可以引用环境变量（`${NAME}`）或命令（`!cmd`）。 */
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
	/**
	 * 发送 pi 某个 provider 的 token（`/login <provider>`），而不是走 OAuth。项目级 `mcp.json` 不允许这样做；
	 * 且除回环主机外必须用 https，因为它要把凭证发送到 `url`。
	 */
	auth?: { provider: string };
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/** 某 server 工具的命名空间：`mcp__<server>`，其中 `-` 换成 `_`，与工具名一致。 */
export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function validateOAuth(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
		return "oauth.clientSecret must be a string";
	}
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		return "oauth.callbackPort must be a port number";
	}
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) {
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
		const urlPort = new URL(value.callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port) {
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
		}
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) {
		return "oauth.clientName must be a non-empty string";
	}
	if (value.clientRegistration !== undefined && value.clientRegistration !== "dcr") {
		if (value.clientRegistration !== "cimd") return 'oauth.clientRegistration must be "dcr" or "cimd"';
		if (value.clientId !== undefined || value.clientName !== undefined) {
			return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		}
		const callback = typeof value.callbackUrl === "string" ? new URL(value.callbackUrl) : undefined;
		if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
			return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
		}
	}
	const metadataUrl = value.authServerMetadataUrl;
	if (metadataUrl !== undefined) {
		const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
		}
	}
	return undefined;
}

function isExposure(value: unknown): value is McpExposure {
	return typeof value === "string" && MCP_EXPOSURES.includes(value);
}

/** 别名代表的 exposure；其余值原样返回。 */
function resolveExposureAlias(value: unknown): unknown {
	return typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

/** 一份服务器条目的副本，其中的 exposure 别名已替换为其现行名称。 */
function resolveExposureAliases(value: Record<string, unknown>): Record<string, unknown> {
	const { exposure, toolExposure } = value;
	const resolved: Record<string, unknown> = { ...value };
	if (exposure !== undefined) resolved.exposure = resolveExposureAlias(exposure);
	if (isRecord(toolExposure)) {
		resolved.toolExposure = Object.fromEntries(
			Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveExposureAlias(entry)]),
		);
	}
	return resolved;
}

/** 某 server 的某个工具的 exposure：其 `toolExposure` 条目，否则为 server 的 `exposure`。 */
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	const overrides = config.toolExposure ?? {};
	const exact = overrides[toolName];
	if (exact !== undefined) return exact;
	for (const [pattern, exposure] of Object.entries(overrides)) {
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	}
	return config.exposure ?? "codemode";
}

/**
 * 校验 `mcpServers` 形状的一个 server 条目。返回 exposure 别名已解析的配置副本，或一条错误消息。
 */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const value = resolveExposureAliases(raw);
	const { type, exposure, enabled, timeout, toolExposure, description } = value;
	const exposures = MCP_EXPOSURES.map((value) => `"${value}"`).join(", ");
	if (exposure !== undefined && !isExposure(exposure)) {
		return `server "${name}": exposure must be one of ${exposures}`;
	}
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, value] of Object.entries(toolExposure)) {
			if (!isExposure(value)) return `server "${name}": toolExposure "${tool}" must be one of ${exposures}`;
		}
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (description !== undefined && typeof description !== "string") {
		return `server "${name}": description must be a string`;
	}
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
		return `server "${name}": timeout must be a positive number of seconds`;
	}
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;

	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
			return `server "${name}": url must be an http or https URL`;
		}
		if (value.headers !== undefined && !isStringRecord(value.headers)) {
			return `server "${name}": headers must map names to strings`;
		}
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		if (value.auth !== undefined) {
			if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider) {
				return `server "${name}": auth.provider must be a provider name`;
			}
			const url = new URL(value.url);
			if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
				return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
			}
		}
		return value as unknown as McpHttpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (
			value.args !== undefined &&
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		) {
			return `server "${name}": args must be an array of strings`;
		}
		if (value.env !== undefined && !isStringRecord(value.env))
			return `server "${name}": env must map names to strings`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		return value as unknown as McpStdioServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/** 某个扩展通过 `pi.registerMcpServer()` 注册的 server。 */
export interface RegisteredMcpServer {
	name: string;
	config: McpServerConfig;
	/** 注册该 server 的扩展的路径。 */
	extensionPath: string;
}

/** 由一个运行时的所有扩展注册的 servers。 */
export class McpServerRegistry {
	private readonly servers = new Map<string, RegisteredMcpServer>();
	private changeListener: (() => void) | undefined;

	/** 注册或替换一个 server。由调用方检查所有权。 */
	register(server: RegisteredMcpServer): void {
		this.servers.set(server.name, server);
		this.changeListener?.();
	}

	/** 移除由 `extensionPath` 注册的 server。其他扩展的 server 不受影响。 */
	unregister(name: string, extensionPath: string): void {
		if (this.servers.get(name)?.extensionPath !== extensionPath) return;
		this.servers.delete(name);
		this.changeListener?.();
	}

	get(name: string): RegisteredMcpServer | undefined {
		return this.servers.get(name);
	}

	/** 已注册 server 的副本，按注册顺序。 */
	list(): RegisteredMcpServer[] {
		return [...this.servers.values()].map((server) => ({ ...server, config: structuredClone(server.config) }));
	}

	/** 每次变更后调用。runner 在绑定时设置它，用来发出 `mcp_servers_change`。 */
	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}
}
