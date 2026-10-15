/**
 * MCP 集成中负责与服务器通信的部分：连接、传输和 OAuth 登录。由于此模块会引入 MCP 客户端，
 * 因此只有配置了服务器时，index.ts 才会通过 runtime.lazy.ts 加载它。
 */

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	type AuthProvider,
	type CallToolResult,
	JSON_RPC_ERROR_CODES,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	McpAuthRequiredError,
	McpClient,
	McpError,
	McpHttpError,
	type McpRequestOptions,
	McpSessionExpiredError,
	type Tool as McpTool,
	type McpTransport,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import { VERSION } from "../../config.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/resolve-config-value.ts";
import type { McpServerEntry } from "./config.ts";
import type { McpServerLog } from "./log.ts";
import {
	createMcpAuthProvider,
	type McpAuthProvider,
	type McpOAuthCredentialStore,
	type McpOAuthSettings,
} from "./oauth.ts";
import { isMcpAppResource, type McpResourceServer } from "./resources.ts";
import type { McpToolCaller } from "./tools.ts";

export { McpServerLog } from "./log.ts";
export { McpOAuthCredentialStore, McpSignInCancelledError, signInMcpServer } from "./oauth.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
/** HTTP 服务器因暂时性错误连接失败后，每次重试之间的等待时间。 */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

/**
 * `disconnected`：连接已断开（例如 stdio 服务器已退出）；下次调用时会重新连接。
 */
type ServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

export type McpTransportFactory = (
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
) => McpTransport;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 网络故障、服务器过载或正在重启等值得重试的情况。 */
function isTransientError(error: unknown): boolean {
	if (error instanceof McpHttpError) {
		return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	}
	return error instanceof TypeError;
}

function signInRequiredMessage(entry: McpServerEntry): string {
	const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
	return `MCP server "${entry.name}" requires sign-in. Run ${provider ? `/login ${provider}` : "/mcp"} to sign in.`;
}

/** HTTP 服务器默认使用 OAuth 身份验证；配置中提供 `Authorization` 标头或 `auth` 时除外。 */
function usesOAuth(entry: McpServerEntry): boolean {
	const { config } = entry;
	if (!("url" in config) || config.auth) return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/** 与 shell 一样，`~` 和 `~/…`（Windows 上也包括 `~\…`）表示主目录。 */
function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

export function createDefaultTransport(
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
		});
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	return new StdioTransport({
		command: expandHome(config.command),
		args: config.args?.map(expandHome),
		cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
		env,
		stderr: "pipe",
	});
}

/** 未实现 `resources/templates/list` 的服务器不提供模板。 */
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
	try {
		return await list();
	} catch (error) {
		if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
		throw error;
	}
}

function listTemplates(client: McpClient, options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
	return withoutTemplates(() => client.listResourceTemplates(options), []);
}

/**
 * 连接时读取资源和模板，用于显示 `/mcp` 和 `pi mcp list` 中的数量。即使服务器的列表读取失败，
 * 连接仍会建立：资源工具会在需要时列出并读取资源。
 */
async function fetchResources(
	client: McpClient,
): Promise<{ resources: Resource[]; resourceTemplates: ResourceTemplate[] }> {
	const [resources, resourceTemplates] = await Promise.all([
		client.listResources().catch(() => []),
		listTemplates(client).catch(() => []),
	]);
	return {
		resources: resources.filter((resource) => !isMcpAppResource(resource)),
		resourceTemplates: resourceTemplates.filter((template) => !isMcpAppResource(template)),
	};
}

/** 一个已配置的服务器。调用发现连接已断开时，会延迟到该时机重新连接。 */
export class McpServerConnection implements McpToolCaller, McpResourceServer {
	readonly entry: McpServerEntry;
	state: ServerState = "connecting";
	error: string | undefined;
	tools: McpTool[] = [];
	/**
	 * 服务器是否提供资源。以下列表记录了最近一次连接或资源变更时服务器返回的内容，不包含 MCP App 资源。
	 */
	hasResources = false;
	resources: Resource[] = [];
	resourceTemplates: ResourceTemplate[] = [];
	/** `initialize` 返回的服务器指令，用于整体描述其工具。 */
	instructions: string | undefined;
	/** 服务器最近一次返回的 OAuth challenge；登录时会使用其中的资源元数据 URL 和 scope。 */
	challenge: OAuthChallenge | undefined;
	private client: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	/** 由 `close()` 中止；会取消正在进行的连接，包括重试间隔中的等待。 */
	private readonly shutdown = new AbortController();
	/** 最近一次连接失败的 stdio 服务器的 stderr 内容。 */
	private stderrTail: string | undefined;
	private readonly cwd: string;
	private readonly createTransport: McpTransportFactory;
	private readonly authProvider: McpAuthProvider | undefined;
	private readonly onTools: (connection: McpServerConnection) => void;
	private readonly onChange: ((connection: McpServerConnection) => void) | undefined;
	private readonly log: McpServerLog | undefined;

	constructor(options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport: McpTransportFactory;
		credentials: McpOAuthCredentialStore;
		/** 对于配置了 `auth.provider` 的服务器，返回对应 pi 提供商的当前令牌。 */
		providerToken?: (provider: string) => Promise<string | undefined>;
		onTools: (connection: McpServerConnection) => void;
		/** `state`、`error` 或 `tools` 发生变化时调用。 */
		onChange?: (connection: McpServerConnection) => void;
		/** 接收服务器日志消息（`notifications/message`）。 */
		log?: McpServerLog;
	}) {
		this.entry = options.entry;
		this.cwd = options.cwd;
		this.createTransport = options.createTransport;
		this.onTools = options.onTools;
		this.onChange = options.onChange;
		this.log = options.log;
		const url = this.oauthUrl;
		const provider = "url" in this.entry.config ? this.entry.config.auth?.provider : undefined;
		this.authProvider = url
			? createMcpAuthProvider({
					serverUrl: url,
					store: options.credentials.forServer(this.entry.name, url),
					settings: () => this.oauthSettings(),
					onChallenge: (challenge) => {
						this.challenge = challenge;
					},
				})
			: provider
				? // 每次请求时重新读取，以应用提供商的最新凭据；MCP 不会保存副本。
					{ token: async () => options.providerToken?.(provider), settled: async () => {} }
				: undefined;
	}

	get name(): string {
		return this.entry.name;
	}

	private get closed(): boolean {
		return this.shutdown.signal.aborted;
	}

	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** 使用 OAuth 身份验证时的服务器 URL。 */
	get oauthUrl(): string | undefined {
		return usesOAuth(this.entry) && "url" in this.entry.config ? this.entry.config.url : undefined;
	}

	oauthSettings(): McpOAuthSettings {
		const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
		if (!oauth) return {};
		return {
			clientId: oauth.clientId,
			clientSecret:
				oauth.clientSecret === undefined
					? undefined
					: resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.entry.name}" oauth.clientSecret`),
			callbackPort: oauth.callbackPort,
			callbackUrl: oauth.callbackUrl,
			scope: oauth.scope,
			clientName: oauth.clientName,
			clientRegistration: oauth.clientRegistration,
			authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
		};
	}

	getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult> {
		return this.withClient((client) => client.callTool(name, args, options));
	}

	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
		return this.withClient((client) => client.readResource(uri, options), true);
	}

	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult> {
		return this.withClient((client) => client.listResourcesPage(cursor, options), true);
	}

	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult> {
		return this.withClient(
			(client) =>
				withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), { resourceTemplates: [] }),
			true,
		);
	}

	allResources(options: McpRequestOptions): Promise<Resource[]> {
		return this.withClient((client) => client.listResources(options), true);
	}

	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]> {
		return this.withClient((client) => listTemplates(client, options), true);
	}

	/**
	 * 执行请求，并在需要时重新连接。`readOnly` 请求遇到暂时性 HTTP 错误后会重试一次；
	 * 工具调用不会重试，因为它们可能已经执行。
	 */
	private async withClient<T>(run: (client: McpClient) => Promise<T>, readOnly = false): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			const client = await this.getClient();
			try {
				return await run(client);
			} catch (error) {
				if (readOnly && attempt === 1 && error instanceof McpHttpError && isTransientError(error)) {
					await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAYS_MS[0]));
					continue;
				}
				if (error instanceof McpSessionExpiredError && attempt === 1) {
					// 服务器已不认识该会话（例如重启或重新部署），因此没有执行请求。
					// 在新会话中重试一次。旧客户端会解除关联，但不会关闭：关闭它会导致其他正在进行的调用失败，
					// 而这些调用会收到相同的 404，并按同样方式重试。
					if (this.client === client) this.client = undefined;
					continue;
				}
				if (!this.needsSignIn(error)) throw error;
				await this.dropClient(client);
				this.markNeedsAuth();
				throw new Error(signInRequiredMessage(this.entry));
			}
		}
	}

	/** 使用新凭据重新连接，例如完成登录之后。 */
	async reconnect(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		await this.getClient();
	}

	/** 已存储的凭据被删除后断开连接。 */
	async signOut(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		if (!this.closed) this.markNeedsAuth();
	}

	/** OAuth 服务器刷新令牌后仍拒绝请求时，需要用户重新登录。 */
	private needsSignIn(error: unknown): boolean {
		return (
			error instanceof McpOAuthAuthorizationRequiredError ||
			(this.authProvider !== undefined && error instanceof McpAuthRequiredError)
		);
	}

	private markNeedsAuth(): void {
		this.state = "needs-auth";
		this.error = undefined;
		this.changed();
	}

	private changed(): void {
		this.onChange?.(this);
	}

	private async dropClient(client: McpClient): Promise<void> {
		if (this.client === client) this.client = undefined;
		await client.close().catch(() => undefined);
	}

	private async open(): Promise<McpClient> {
		this.state = "connecting";
		this.changed();
		const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
		for (let attempt = 0; ; attempt++) {
			this.stderrTail = undefined;
			try {
				return await this.connectOnce();
			} catch (error) {
				const delay = retries[attempt];
				if (this.closed || delay === undefined || !isTransientError(error)) {
					throw this.connectFailed(error);
				}
				await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(() => undefined);
				if (this.closed) throw this.connectFailed(error);
			}
		}
	}

	private async connectOnce(): Promise<McpClient> {
		const client = new McpClient({
			name: "pi",
			version: VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		const log = this.log;
		if (log) client.onNotification("notifications/message", (params) => log.write(this.entry.name, params));
		// 关闭客户端会使待处理的 initialize 或服务发现请求失败，并关闭传输层。
		// 此操作有记忆化处理：第二次调用 `client.close()` 会在第一次关闭传输层完成前返回。
		let closing: Promise<void> | undefined;
		const closeClient = () => {
			closing ??= client.close().catch(() => undefined);
			return closing;
		};
		this.shutdown.signal.addEventListener("abort", closeClient, { once: true });
		let transport: McpTransport | undefined;
		try {
			transport = this.createTransport(this.entry, this.cwd, this.authProvider);
			await client.connect(transport);
			client.onNotification("notifications/tools/list_changed", () => {
				void this.refreshTools(client);
			});
			client.onNotification("notifications/resources/list_changed", () => {
				void this.refreshResources(client);
			});
			const stdio = transport instanceof StdioTransport ? transport : undefined;
			client.onClose(() => this.handleClientClose(client, stdio));
			// 仅支持 prompts 或 resources、没有 tools 能力的服务器不会响应 tools/list。
			const hasResources = client.serverCapabilities?.resources !== undefined;
			const [tools, resources] = await Promise.all([
				client.serverCapabilities?.tools ? client.listTools() : [],
				hasResources ? fetchResources(client) : { resources: [], resourceTemplates: [] },
			]);
			if (this.closed) throw new Error("shut down while connecting");
			if (client.connectionState !== "connected") throw new Error("connection closed during setup");
			this.client = client;
			this.tools = tools;
			this.hasResources = hasResources;
			this.resources = resources.resources;
			this.resourceTemplates = resources.resourceTemplates;
			this.instructions = client.instructions?.trim() || undefined;
			this.state = "connected";
			this.error = undefined;
			this.onTools(this);
			this.changed();
			return client;
		} catch (error) {
			await closeClient();
			if (transport instanceof StdioTransport) {
				this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
			}
			throw error;
		} finally {
			this.shutdown.signal.removeEventListener("abort", closeClient);
		}
	}

	private connectFailed(error: unknown): Error {
		if (this.needsSignIn(error) && !this.closed) {
			this.markNeedsAuth();
			return new Error(signInRequiredMessage(this.entry));
		}
		this.state = this.closed ? "closed" : "failed";
		this.error = this.stderrTail ? `${errorMessage(error)}\n${this.stderrTail}` : errorMessage(error);
		this.changed();
		return new Error(`MCP server "${this.entry.name}" failed to connect: ${this.error}`);
	}

	/** 传输连接已断开。下次调用时会重新连接；在此之前状态中会显示断开原因。 */
	private handleClientClose(client: McpClient, stdio: StdioTransport | undefined): void {
		if (this.client !== client || this.closed) return;
		this.client = undefined;
		this.state = "disconnected";
		const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
		this.error = stderr ? `Connection closed\n${stderr}` : "Connection closed";
		this.changed();
	}

	private async refreshTools(client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools();
			if (this.client !== client || this.closed) return;
			this.tools = tools;
			this.onTools(this);
		} catch (error) {
			this.error = `Failed to refresh tools: ${errorMessage(error)}`;
		}
		this.changed();
	}

	private async refreshResources(client: McpClient): Promise<void> {
		const { resources, resourceTemplates } = await fetchResources(client);
		if (this.client !== client || this.closed) return;
		this.resources = resources;
		this.resourceTemplates = resourceTemplates;
		this.onTools(this);
		this.changed();
	}

	/** 此服务器的所有传输连接都已关闭后完成，包括仍处于连接过程中的传输。 */
	async close(): Promise<void> {
		this.shutdown.abort();
		this.state = "closed";
		this.changed();
		const client = this.client;
		this.client = undefined;
		await Promise.all([client?.close().catch(() => undefined), this.opening?.catch(() => undefined)]);
		// 服务器可能已响应刷新请求并轮换 refresh token；若在保存新令牌前退出，就会丢失授权。
		await this.authProvider?.settled();
	}
}
