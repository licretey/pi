/**
 * 远程 MCP 服务器的 OAuth 登录。
 *
 * 连接本身绝不主动发起浏览器流程。它们发送已存储的 access token，收到 401 后尝试已存储的
 * refresh token。当无法这样做时，抛出 `McpOAuthAuthorizationRequiredError`，由用户通过 `/mcp`
 * 登录——它针对 loopback 回调运行授权码流程（PKCE、Client ID Metadata Document 或动态客户端注册）。
 *
 * 凭证保存在 `<agent-dir>/mcp-auth.json` 中，按服务器名称和 URL 索引。
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import {
	type AuthorizationServerMetadata,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	type McpOAuthStateStore,
	type OAuthCallback,
	type OAuthCallbackPage,
	OAuthCallbackServer,
	type OAuthChallenge,
	type OAuthClientInformationMixed,
	type OAuthClientMetadataDocument,
	parseWwwAuthenticate,
	stepUpScope,
} from "@earendil-works/pi-mcp/oauth";
import lockfile from "proper-lockfile";
import { APP_NAME, getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { mcpNamespace } from "../../core/mcp-servers.ts";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** pi.dev 托管 pi 的 Client ID Metadata Document 的地址：`client.json` 与 `<callback ID>/client.json`。 */
const CLIENT_METADATA_BASE_URL = "https://pi.dev/oauth";
/** 未存储 redirect URI 时刷新所用的地址。刷新从不重定向用户。 */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/** 距过期只剩这么长时间的 access token 会在发送前先刷新。 */
const REFRESH_SKEW_MS = 30_000;
/**
 * 限定对授权服务器的每次请求时长，防止无响应的授权服务器长时间占用刷新锁、
 * 拖延关机或让登录流程久等。
 */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
/** 持有者停止续期（进程被杀）的刷新锁在此之后可被接管。 */
const REFRESH_LOCK_STALE_MS = 20_000;
/** 等待其他进程完成刷新的时长：比一把过期锁的存活时间更长。 */
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;

export interface McpOAuthSettings {
	clientId?: string;
	/** 已解析完毕。 */
	clientSecret?: string;
	callbackPort?: number;
	/** loopback 重定向 URI；见 `McpOAuthConfig.callbackUrl`。 */
	callbackUrl?: string;
	/** 要请求的 scope，以空格分隔。 */
	scope?: string;
	/** 动态客户端注册的 `client_name`。默认：`APP_NAME`。 */
	clientName?: string;
	/** 见 `McpOAuthConfig.clientRegistration`。 */
	clientRegistration?: "dcr" | "cimd";
	/** 见 `McpOAuthConfig.authServerMetadataUrl`。 */
	authServerMetadataUrl?: URL;
}

/** loopback 回调服务器的监听位置及其服务的重定向 URI。 */
interface CallbackSettings {
	/** 监听地址。 */
	host: string;
	/** 重定向 URI 中的主机名。 */
	redirectHost: string;
	port: number | undefined;
	path: string;
	/** 端口固定时的精确重定向 URI。 */
	fixedRedirectUrl: string | undefined;
}

function callbackSettings(settings: McpOAuthSettings): CallbackSettings {
	const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
	const address = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : settings.callbackPort;
	let fixedRedirectUrl: string | undefined;
	// 带端口的已配置 URI 会按原样发送，因为服务器按字符串精确比较它。
	if (url.port) fixedRedirectUrl = settings.callbackUrl;
	else if (port !== undefined) {
		url.port = String(port);
		fixedRedirectUrl = url.href;
	}
	return {
		// `localhost` 由 127.0.0.1 服务；当 ::1 拒绝连接时浏览器会回退到它。
		host: address === "localhost" ? CALLBACK_HOST : address,
		redirectHost: address,
		port,
		path: url.pathname,
		fixedRedirectUrl,
	};
}

/** 两个列表 scope 的并集，各出现一次。 */
function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
	const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
	return merged.length > 0 ? merged.join(" ") : undefined;
}

type StoredStates = Record<string, McpOAuthState>;

function parseStates(content: string | undefined): StoredStates {
	if (!content?.trim()) return {};
	const parsed: unknown = JSON.parse(content);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StoredStates) : {};
}

function serializeStates(states: StoredStates): string {
	return `${JSON.stringify(states, null, 2)}\n`;
}

/**
 * 服务器状态的键：按名称和 URL 存，这样共享同一 URL 的服务器能保留各自的账号；
 * 另有仅按 URL 的旧版键，由旧版本写入。
 */
function storeKeys(name: string, serverUrl: string): { key: string; legacyKey: string } {
	const legacyKey = String(new URL(serverUrl));
	return { key: `${mcpNamespace(name)}|${legacyKey}`, legacyKey };
}

export interface McpOAuthServerStore extends McpOAuthStateStore {
	/** 在没有其他进程刷新该服务器 token 时运行 `fn`。 */
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** 每个服务器的 OAuth 状态（客户端注册、token、待用的 PKCE verifier），存于 `mcp-auth.json`。 */
export class McpOAuthCredentialStore {
	private readonly backend: AuthStorageBackend;
	/** 刷新锁文件所在目录。没有它时，刷新只在本进程内串行化。 */
	private readonly lockDir: string | undefined;

	constructor(backend?: AuthStorageBackend, lockDir?: string) {
		this.backend = backend ?? new FileAuthStorageBackend(join(getAgentDir(), "mcp-auth.json"));
		this.lockDir = backend ? lockDir : getAgentDir();
	}

	forServer(name: string, serverUrl: string): McpOAuthServerStore {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		return {
			// 第一个加载旧版状态的服务器将其接管；其他同 URL 的服务器需重新登录。
			load: () =>
				this.backend.withLock((current) => {
					const states = parseStates(current);
					if (states[key] || !states[legacyKey]) return { result: states[key] };
					states[key] = states[legacyKey];
					delete states[legacyKey];
					return { result: states[key], next: serializeStates(states) };
				}),
			save: (state) =>
				this.write((states) => {
					states[key] = state;
				}),
			withRefreshLock: (fn) => this.withRefreshLock(key, fn),
		};
	}

	/**
	 * 每个服务器一把锁文件。进程正常退出时，proper-lockfile 会移除它持有的锁；进程被杀时，
	 * 锁因不再续期而过期作废，由下一个进程接管。
	 */
	private async withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		if (!this.lockDir) return fn();
		mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		const release = await lockfile.lock(join(this.lockDir, `mcp-auth-refresh-${hash}`), {
			realpath: false,
			stale: REFRESH_LOCK_STALE_MS,
			retries: {
				retries: REFRESH_LOCK_WAIT_MS / REFRESH_LOCK_RETRY_MS,
				factor: 1,
				minTimeout: REFRESH_LOCK_RETRY_MS,
				maxTimeout: REFRESH_LOCK_RETRY_MS,
			},
			// 默认行为是从定时器中抛出异常。锁丢失最坏情况下也不过是两次刷新重叠。
			onCompromised: () => {},
		});
		try {
			return await fn();
		} finally {
			await release().catch(() => undefined);
		}
	}

	/** 某个服务器已存储的 token，用于察觉另一个进程完成的登录。不接管旧版状态。 */
	tokens(name: string, serverUrl: string): McpOAuthState["tokens"] {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		const states = this.backend.withLock((current) => ({ result: parseStates(current) }));
		return (states[key] ?? states[legacyKey])?.tokens;
	}

	/** 返回该服务器是否已存有凭证。会顺带移除该服务器本可接管的旧版状态。 */
	remove(name: string, serverUrl: string): boolean {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		return this.backend.withLock((current) => {
			const states = parseStates(current);
			const stored = key in states ? key : legacyKey in states ? legacyKey : undefined;
			if (!stored) return { result: false };
			delete states[stored];
			return { result: true, next: serializeStates(states) };
		});
	}

	private write(update: (states: StoredStates) => void): void {
		this.backend.withLock((current) => {
			const states = parseStates(current);
			update(states);
			return { result: undefined, next: serializeStates(states) };
		});
	}
}

/** 在请求自身的 signal 之上，为每个请求附加 `OAUTH_REQUEST_TIMEOUT_MS` 的 `fetch`。 */
function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

/** 用于在回调路径中标识 MCP 服务器 URL 的 12 字符串，计算方式与 Codex 相同。 */
function callbackId(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.hash = "";
	return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

/**
 * pi 的 Client ID Metadata Document，用于 `clientRegistration: "cimd"`，挑选方式与 Codex 为自己挑选的相同。
 * 该配置确保使用默认回调路径。授权响应中没有 `iss` 参数（RFC 9207）时，redirect URI 和文档都是
 * 特定于该 MCP 服务器的，因此一个响应不会被混同于来自另一个授权服务器的响应（RFC 9700 第 4.4.2.2 节）。
 */
function clientMetadataDocument(
	serverUrl: string,
	redirectUrl: string,
	metadata: AuthorizationServerMetadata | undefined,
): OAuthClientMetadataDocument {
	if (
		!metadata?.client_id_metadata_document_supported ||
		!metadata.token_endpoint_auth_methods_supported?.includes("none")
	) {
		throw new Error(
			'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
		);
	}
	if (metadata.authorization_response_iss_parameter_supported) {
		return { url: `${CLIENT_METADATA_BASE_URL}/client.json`, redirectUrl };
	}
	const id = callbackId(serverUrl);
	const redirect = new URL(redirectUrl);
	redirect.pathname = `${CALLBACK_PATH}/${id}`;
	return { url: `${CLIENT_METADATA_BASE_URL}/${id}/client.json`, redirectUrl: redirect.href };
}

function createProvider(
	serverUrl: string,
	store: McpOAuthStateStore,
	settings: McpOAuthSettings,
	redirectUrl: string,
	onRedirect: (url: URL) => void,
): McpOAuthProvider {
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: settings.clientName ?? APP_NAME },
		clientMetadataDocument:
			settings.clientRegistration === "cimd"
				? (metadata) => clientMetadataDocument(serverUrl, redirectUrl, metadata)
				: undefined,
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		store,
		onRedirect,
	});
}

export interface McpAuthProvider extends AuthProvider {
	/** 当没有刷新正在进行时 resolve，保证关机不会在轮换出的 token 保存之前将其丢弃。 */
	settled(): Promise<void>;
}

/**
 * MCP 连接的 auth provider：发送已存储的 access token，并在其即将过期或收到 401 后刷新。
 * 当用户必须登录时抛出 `McpOAuthAuthorizationRequiredError`，包括服务器要求更多 scope 的情况
 * （`insufficient_scope`）。`onChallenge` 接收服务器的 `WWW-Authenticate` challenge，使登录
 * 流程能使用其中的 resource metadata URL 和 scope。`settings` 只在需要刷新时才被调用，因此
 * 一个解析失败的 secret 只会让刷新失败，而不会让整个连接建立失败。
 *
 * 许多服务器会轮换 refresh token，因此两次使用相同 refresh token 的刷新会导致授权被吊销。
 * 本进程内的请求共享一次刷新，其他进程则被 store 的刷新锁挡在外面——该锁从读取 token 一直
 * 持有到保存新 token。期间被改变的 token（另一进程刷新过，或用户已登录）会被直接使用而不刷新。
 */
export function createMcpAuthProvider(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: () => McpOAuthSettings;
	onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
	const { serverUrl, store } = options;
	let refreshing: Promise<void> | undefined;

	/** 替换 `staleToken`——即已过期或被拒绝的 access token。 */
	const refresh = (staleToken: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) => {
		refreshing ??= store
			.withRefreshLock(async () => {
				const state = await store.load();
				if (state?.tokens?.access_token !== staleToken) return;
				if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				const settings = options.settings();
				const redirectUrl =
					callbackSettings(settings).fixedRedirectUrl ??
					registeredRedirectUrls(state.clientInformation)[0] ??
					FALLBACK_REDIRECT_URL;
				const provider = createProvider(serverUrl, store, settings, redirectUrl, () => {});
				// 刷新 token，或报告需要重新登录。不可取消：服务器已应答的刷新可能
				// 轮换过 refresh token，因此其应答必须被保存。
				const result = await authorizeMcp(provider, {
					serverUrl,
					resourceMetadataUrl: challenge?.resourceMetadataUrl,
					authorizationServerMetadataUrl: settings.authServerMetadataUrl,
					scope: challenge?.scope,
					fetch: timedFetch(fetch),
				});
				if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
			})
			.finally(() => {
				refreshing = undefined;
			});
		return refreshing;
	};

	return {
		token: async () => {
			await refreshing?.catch(() => undefined);
			const state = await store.load();
			const token = state?.tokens?.access_token;
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
			if (!expired || !state?.tokens?.refresh_token) return token;
			// 失败则顺其自然：请求带着旧 token 发出，由 401 决定后续如何处理。
			await refresh(token).catch(() => undefined);
			return (await store.load())?.tokens?.access_token;
		},
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			options.onChallenge(challenge);
			// 刷新会保留已授予的 scope，因此要求更多 scope 需要一次新的登录。
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			await refresh(context.token, context.fetch, challenge);
		},
		settled: async () => {
			await refreshing?.catch(() => undefined);
		},
	};
}

export interface McpSignInPrompt {
	/** 向用户展示授权 URL 并在浏览器中打开。 */
	showAuthorizationUrl(url: URL): void;
	/**
	 * 请用户从浏览器地址栏粘贴重定向 URL，用于浏览器无法访问 loopback 回调的情况
	 * （例如通过 SSH）。回调到达或登录被取消后立即中止。用户取消时 resolve 为
	 * `undefined` 或空字符串。
	 */
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export class McpSignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "McpSignInCancelledError";
	}
}

type AuthorizationResponse = Pick<OAuthCallback, "code" | "iss">;

function responseFromRedirectUrl(input: string, state: string, redirectUrl: URL): AuthorizationResponse {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Expected the full redirect URL from the browser address bar");
	}
	// 特定于服务器的 redirect URI 可用于区分不同的授权服务器，因此必须精确匹配。
	if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
		throw new Error("The redirect URL does not match this sign-in's redirect URI");
	}
	const error = url.searchParams.get("error");
	if (error) throw new Error(url.searchParams.get("error_description") ?? error);
	if (url.searchParams.get("state") !== state) throw new Error("The redirect URL belongs to a different sign-in");
	const code = url.searchParams.get("code");
	if (!code) throw new Error("The redirect URL does not contain an authorization code");
	return { code, iss: url.searchParams.get("iss") ?? undefined };
}

/**
 * 等待浏览器回调或用户粘贴的重定向 URL，以先到达者为准。中止 `signal` 会中止提示，
 * 进而取消本次登录。
 */
async function waitForAuthorizationResponse(
	callback: OAuthCallbackServer,
	state: string,
	redirectUrl: URL,
	prompt: McpSignInPrompt,
	signal: AbortSignal | undefined,
): Promise<AuthorizationResponse> {
	const controller = new AbortController();
	const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
	const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname);
	const fromUser = prompt.promptForRedirectUrl(promptSignal).then((input) => {
		if (!input?.trim()) throw new McpSignInCancelledError();
		return responseFromRedirectUrl(input, state, redirectUrl);
	});
	try {
		return await Promise.race([fromBrowser, fromUser]);
	} finally {
		// 落败的一方（提示被中止或回调服务器关闭）会在此时 reject。
		controller.abort();
		fromBrowser.catch(() => undefined);
		fromUser.catch(() => undefined);
	}
}

/** 监听 `port`；当端口被占用且并非 `required` 时，改监听一个空闲端口。 */
async function listenForCallback(
	settings: CallbackSettings,
	extraPaths: string[],
	port: number | undefined,
	required: boolean,
): Promise<OAuthCallbackServer> {
	const options = {
		host: settings.host,
		redirectHost: settings.redirectHost,
		path: settings.path,
		extraPaths,
		renderPage: (page: OAuthCallbackPage) =>
			page.ok
				? oauthSuccessHtml("Signed in to the MCP server. You may now close this page.")
				: oauthErrorHtml(page.message, page.details),
	};
	try {
		return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 });
	} catch (error) {
		if (required || port === undefined) throw error;
		return OAuthCallbackServer.listen(options);
	}
}

/**
 * 登录 MCP 服务器。尽可能使用已存储的 refresh token；否则运行浏览器授权码流程。
 * Token 会保存到 `store`。中止 `signal` 会在任意步骤以 `McpSignInCancelledError` 终止登录；
 * 发往授权服务器的请求同样受时间限制。
 */
export async function signInMcpServer(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
	challenge?: OAuthChallenge;
	prompt: McpSignInPrompt;
	signal?: AbortSignal;
}): Promise<void> {
	const { serverUrl, store, settings, signal } = options;
	if (signal?.aborted) throw new McpSignInCancelledError();
	const stored = await store.load();
	const stepUp = options.challenge?.error === "insufficient_scope";
	const callbackOptions = callbackSettings(settings);
	// 复用已注册 redirect URI 的端口，以保持已注册客户端仍然有效。
	const registered = registeredRedirectUrls(stored?.clientInformation)[0];
	const preferredPort =
		callbackOptions.port ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
	const cimd = settings.clientRegistration === "cimd";
	const callback = await listenForCallback(
		callbackOptions,
		// 特定于服务器的 Client ID Metadata Document 的 redirect URI。
		cimd ? [`${CALLBACK_PATH}/${callbackId(serverUrl)}`] : [],
		preferredPort,
		callbackOptions.port !== undefined,
	);
	const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
	try {
		if (stored) {
			const next: McpOAuthState = { ...stored };
			// 每次登录都获得一个全新的 `state` 参数。
			delete next.oauthState;
			// 已注册的客户端不能使用其他 redirect URI，而且其 token 也属于它。Client ID
			// Metadata Document 不会被存储，因此在使用它的情况下，已存储的客户端是此前
			// 注册过的，会被替换。
			const keepClient =
				settings.clientId ||
				(cimd ? !stored.clientInformation : registeredRedirectUrls(stored.clientInformation).includes(redirectUrl));
			if (!keepClient) {
				delete next.clientInformation;
				delete next.tokens;
				delete next.tokensExpireAt;
			}
			await store.save(next);
		}

		let authorizationUrl: URL | undefined;
		const provider = createProvider(serverUrl, store, settings, redirectUrl, (url) => {
			authorizationUrl = url;
		});
		const flow = {
			serverUrl,
			fetch: timedFetch(),
			signal,
			resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
			authorizationServerMetadataUrl: settings.authServerMetadataUrl,
			// 要求更多 scope 的服务器会得到它——叠加在已配置的 scope 之上，并且由于 challenge
			// 可能只列出了缺失的 scope，也叠加在迄今已授予的 scope 之上。
			scope: mergeScopes(
				settings.scope,
				stepUp ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope) : options.challenge?.scope,
			),
		};
		// 刷新会保留已授予的 scope；要求更多的服务器需要浏览器流程。
		const skipRefresh = stepUp;
		if ((await authorizeMcp(provider, { ...flow, skipRefresh })) === "AUTHORIZED") return;
		if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");

		const state = await provider.state();
		// 流程会挑选 redirect URI，它可能是特定于该 MCP 服务器的。
		const authorizationRedirectUrl = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
		options.prompt.showAuthorizationUrl(authorizationUrl);
		const { code, iss } = await waitForAuthorizationResponse(
			callback,
			state,
			authorizationRedirectUrl,
			options.prompt,
			signal,
		);
		await authorizeMcp(provider, { ...flow, authorizationCode: code, iss });
	} catch (error) {
		// 请求中止时会以 signal 的 reason 失败；将其作为取消操作报告。
		if (signal?.aborted) throw new McpSignInCancelledError();
		throw error;
	} finally {
		await callback.close();
	}
}
