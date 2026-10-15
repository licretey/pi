import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { ModelsError } from "../utils/models-error.ts";

export { ModelsError, type ModelsErrorCode } from "../utils/models-error.ts";

import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	/** OAuth 令牌必须至少剩余的有效时长；默认值为五分钟。 */
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
}

/**
 * `Models` 集合中所有操作共用的认证解析逻辑。
 * 已存储的凭据决定提供商的认证方式；只有未存储凭据时才查询外部来源或环境变量。
 * 刷新失败后不会静默回退到环境变量；没有匹配处理器的凭据类型也不会回退。
 */
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);
	return raceWithAbortSignal(
		resolveProviderAuthWithSignal(provider, credentials, authContext, overrides, signal),
		signal,
	);
}

async function resolveProviderAuthWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	signal.throwIfAborted();
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(
			requestAuthContext,
			provider.auth.apiKey,
			provider.id,
			{
				type: "api_key",
				key: overrides.apiKey,
				env: overrides.env,
			},
			signal,
		);
	}

	const stored = await readCredential(credentials, provider.id, signal);
	if (stored) {
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(
				credentials,
				provider.id,
				provider.auth.oauth,
				stored,
				signal,
				overrides?.minOAuthValidityMs,
			);
		}
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		return undefined;
	}

	// 从外部来源获取认证信息（环境变量、AWS 配置档、ADC 文件）。
	return provider.auth.apiKey
		? resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined, signal)
		: undefined;
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/**
 * 在凭据存储锁保护下刷新已存储的 OAuth 凭据，并在释放锁前持久化结果。
 * 在锁内重新检查 `needsRefresh`，确保并发调用和并发进程只执行一次刷新。
 *
 * `signal` 只会取消等待锁的过程。刷新开始后，提供商可能已经轮换刷新令牌，
 * 因此刷新及其持久化不会响应 `signal` 中止，只受超时限制。
 * 否则，已取消的调用方可能会丢弃唯一有效的刷新令牌。需要在取消时立即返回的调用方，
 * 应将此 Promise 与取消信号进行竞速处理。
 *
 * 操作完成后返回已存储的 OAuth 凭据；如果提供商不再有 OAuth 凭据，则返回 undefined。
 */
export async function refreshStoredOAuthCredential(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	needsRefresh: (credential: OAuthCredential) => boolean,
	signal: AbortSignal,
): Promise<OAuthCredential | undefined> {
	let post: Credential | undefined;
	const lockWait = new AbortController();
	const cancelLockWait = () => lockWait.abort(signal.reason);
	signal.addEventListener("abort", cancelLockWait, { once: true });
	if (signal.aborted) cancelLockWait();
	try {
		post = await credentials.modify(
			providerId,
			async (current) => {
				signal.removeEventListener("abort", cancelLockWait);
				signal.throwIfAborted();
				if (current?.type !== "oauth") return undefined; // logged out meanwhile
				if (!needsRefresh(current)) return undefined; // another process/request refreshed
				try {
					return await oauth.refresh(current, AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS));
				} catch (error) {
					throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
				}
			},
			{ signal: lockWait.signal },
		);
	} catch (error) {
		if (error instanceof ModelsError) throw error;
		signal.throwIfAborted();
		throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
	} finally {
		signal.removeEventListener("abort", cancelLockWait);
	}
	return post?.type === "oauth" ? post : undefined;
}

/**
 * 使用双重检查锁解析 OAuth：剩余有效时间不足五分钟的令牌会通过 `refreshStoredOAuthCredential` 刷新。
 */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
	signal: AbortSignal,
	minOAuthValidityMs?: number,
): Promise<AuthResult | undefined> {
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	let credential = stored;

	if (expiresSoon(credential)) {
		// 乐观检查判定令牌已过期；权威检查会在锁内执行。
		const post = await refreshStoredOAuthCredential(credentials, providerId, oauth, expiresSoon, signal);
		if (!post) return undefined; // logged out meanwhile
		credential = post;
		// 常规的五分钟窗口只会触发刷新，不构成提供商契约。显式调用方（如导出 bearer token）
		// 则要求刷新后至少达到指定的有效时长。
		if (minOAuthValidityMs !== undefined && expiresSoon(credential)) {
			throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
		}
	}

	try {
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ ctx: authContext, credential, signal });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
	}
}

async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
