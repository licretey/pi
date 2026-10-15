import type { ProviderEnv, ProviderHeaders } from "../types.ts";

/**
 * 单次模型请求使用的认证信息。如果某个值无法用 `apiKey`、`headers` 或 `baseUrl` 表示，
 * 那它属于提供商配置，而不是认证信息。
 */
export interface ModelAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}

/**
 * 已存储的 API 密钥凭据。`env` 保存提供商范围内的环境或配置值，
 * 例如 Cloudflare 账户 ID 或网关 ID。
 */
export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: ProviderEnv;
}

/** 扩展兼容流程返回的 OAuth 令牌数据。 */
export interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

/** 持久化的标准 OAuth 凭据。 */
export interface OAuthCredential extends OAuthCredentials {
	type: "oauth";
}

/** 每个提供商对应一个带类型标记的凭据，即当前 auth.json 使用的结构。 */
export type Credential = ApiKeyCredential | OAuthCredential;

/** 用于枚举账户或状态的非机密凭据元数据。 */
export interface CredentialInfo {
	providerId: string;
	type: Credential["type"];
}

/** 为公开的认证和凭据操作提供可选的取消信号。 */
export interface AuthOperationOptions {
	signal?: AbortSignal;
}

/**
 * 由应用管理的凭据存储，以 `Provider.id` 为键，每个提供商对应一份凭据。`modify` 是唯一写入入口，
 * 因此所有变更都是串行的“读取-修改-写入”操作；`Models.getAuth()` 会在 `modify` 中刷新 OAuth，
 * 避免并发请求重复刷新已轮换的令牌。应用在登录后通过 `modify(provider.id, async () => credential)`
 * 保存凭据。登录和登出流程由应用负责协调。
 *
 * 错误语义：条目不存在时，`read` 返回 `undefined`。方法仅在存储失败时拒绝；`Models` 会将此类拒绝
 * 包装为错误码为 "auth" 的 `ModelsError`。尽力而为的存储实现也有效，例如提供内存视图，
 * 并在内部记录持久化错误的 coding-agent `AuthStorage`。
 */
export interface CredentialStore {
	/**
	 * 读取已存储的凭据，该凭据可能已过期。供界面显示或状态查询使用；请求认证信息由 `Models.getAuth()` 提供。
	 */
	read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;

	/**
	 * 列出已存储凭据的元数据，不解析或暴露机密信息。列出时不得执行已配置的 API 密钥命令。
	 */
	list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;

	/**
	 * 串行写入，也是唯一写入入口。`fn` 可以读取当前凭据，以支持正确写入（如令牌刷新或刷新期间重新登录）；
	 * 返回新凭据以更新条目，返回 undefined 则保持条目不变。每个提供商 ID 都要互斥；底层存储支持时，
	 * 还需跨进程互斥（例如使用文件锁）。成功后返回写入的凭据；`fn` 的拒绝会继续向上传递。
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined>;

	/** 删除凭据（登出）。实现应使此操作与 `modify` 串行执行。 */
	delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
}

/** 用于解析认证信息的环境访问接口，可注入测试或浏览器实现。 */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	/** 检查文件是否存在。支持开头的 `~`。在浏览器中始终返回 false。 */
	fileExists(path: string): Promise<boolean>;
}

/** 模型认证信息的解析结果。 */
export interface AuthResult {
	auth: ModelAuth;
	/** 从凭据和当前运行环境中解析出的提供商级环境变量或配置值。 */
	env?: ProviderEnv;
	/** 状态界面中显示的易读来源标签，例如 "ANTHROPIC_API_KEY"、"OAuth"、"~/.aws/credentials"。 */
	source?: string;
}

export interface AuthCheck {
	source?: string;
	type: "api_key" | "oauth";
}

export type AuthType = "api_key" | "oauth";

/**
 * 登录期间向用户显示的提示。带外事件完成当前步骤时，`signal` 可用于取消仍在等待的提示；
 * 例如，`manual_code` 提示与回调服务器竞速，回调先完成时便取消该提示。
 */
export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export interface AuthInfoLink {
	url: string;
	label?: string;
}

export type AuthEvent =
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/**
 * 同时供 API 密钥和 OAuth 流程使用的登录交互回调。
 *
 * `prompt()` 返回输入或选择的字符串（`select` 返回选项 ID）。取消或中止时会拒绝。
 * `signal` 用于中止整个登录流程；单个提示使用 `AuthPrompt.signal` 取消。
 */
export interface AuthInteraction {
	signal?: AbortSignal;

	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

/** 传递给提供商登录实现的标准化交互接口。 */
export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };

/**
 * API 密钥认证：已存储的密钥和提供商环境配置，以及环境变量、AWS 配置档、ADC 文件等外部来源。
 * 仅使用外部来源的提供商不提供 `login`。
 */
export interface ApiKeyAuth {
	/** 显示名称，例如 "Anthropic API key"。 */
	name: string;

	/** 交互式设置（提示输入密钥或提供商环境信息）；缺省表示仅使用当前环境中的信息。 */
	login?(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>;

	/**
	 * 可选的无副作用可用性检查。如果 `resolve()` 可能执行命令或进行其他请求时操作，应使用此方法。
	 * 未提供时，Models 会通过解析认证信息来检查可用性。
	 */
	check?(input: {
		ctx: AuthContext;
		credential?: ApiKeyCredential;
		signal: AbortSignal;
	}): Promise<AuthCheck | undefined>;

	/**
	 * 根据已存储凭据和/或外部来源解析认证信息，并逐字段合并
	 *（`credential.key ?? env("...")`、`credential.env?.NAME ?? env("...")`）。
	 * 返回 undefined 表示尚未配置。解析按提供商进行；模型专属的端点准备会在认证解析后执行。
	 */
	resolve(input: {
		ctx: AuthContext;
		credential?: ApiKeyCredential;
		signal: AbortSignal;
	}): Promise<AuthResult | undefined>;
}

/** 应用为 `Models.login` 提供的上下文。 */
export interface LoginOptions {
	/**
	 * 返回此应用安装实例的稳定 ID，例如作为 agent host ID 发送给 OpenAI。
	 * 只有需要该 ID 的登录流程才会调用此方法，因此应用可以在首次使用时创建 ID，之后必须始终返回相同的 ID。
	 */
	getDeviceId?: () => string;
	/**
	 * 登录时此应用用于自我标识的名称，例如 OpenAI 的 agent 名称提示和 Codex originator。
	 * 默认使用 pi 自身的名称。
	 */
	agentName?: string;
}

/**
 * OAuth 认证。拆分为 `refresh` 和 `toAuth` 后，`Models` 可以统一管理带锁的刷新流程：
 * `refresh` 生成凭据，`toAuth` 根据最终存储的凭据生成请求认证信息。
 */
export interface OAuthAuth {
	/** 显示名称，例如 "Anthropic (Claude Pro/Max)"。 */
	name: string;

	/** 此认证方式是否由提供商订阅服务提供支持。 */
	isSubscription?: boolean;

	/** OAuth 登录选项的选择器标签，例如 "Sign in with SuperGrok or X Premium"。 */
	loginLabel?: string;

	login(interaction: ProviderAuthInteraction, options?: LoginOptions): Promise<OAuthCredential>;

	/**
	 * 兑换刷新令牌。这是网络调用；失败时会抛出异常（如 invalid_grant）。
	 * `Models` 会在存储锁保护下调用此方法。
	 */
	refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;

	/**
	 * 根据有效凭据生成请求认证信息，不产生副作用。
	 * 支持凭据指定的 baseUrl（如 GitHub Copilot）。此方法为异步，以便延迟加载的包装器能在首次使用时加载实现。
	 */
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * 提供商认证。`apiKey` 和 `oauth` 至少要提供一个：即使提供商使用外部凭据，或者是无需密钥的本地服务器，
 * 也会提供 `apiKey` 认证，其 `resolve()` 用于报告提供商是否已配置。
 */
export interface ProviderAuth {
	apiKey?: ApiKeyAuth;
	oauth?: OAuthAuth;
}
