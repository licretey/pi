import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * 标准 API 密钥认证：优先使用已存储的凭据密钥，否则使用第一个已设置的环境变量解析认证信息。
 * 此实现还提供用于提示输入密钥的 `login` 方法。
 * 使用非标准解析方式（提供商环境配置、外部文件、IAM）的提供商应自行实现 `ApiKeyAuth`。
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			return undefined;
		},
	};
}

/**
 * 包装动态导入的 `OAuthAuth`，使提供商定义可以声明支持 OAuth，而无需导入其实现。
 * 首次调用 `login`、`refresh` 或 `toAuth` 时才加载授权流程；调用方通过打包器无法静态解析的动态导入
 *（变量形式的标识符，参见 bedrock 延迟加载包装器）避免将 Node 专用流程代码打入 bundle。
 */
export function lazyOAuth(input: {
	name: string;
	isSubscription?: boolean;
	loginLabel?: string;
	load: () => Promise<OAuthAuth>;
}): OAuthAuth {
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		isSubscription: input.isSubscription,
		loginLabel: input.loginLabel,
		login: async (interaction, options) => (await loaded()).login(interaction, options),
		refresh: async (credential, signal) => (await loaded()).refresh(credential, signal),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
