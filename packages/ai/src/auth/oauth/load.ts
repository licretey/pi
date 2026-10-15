import type { OAuthAuth } from "../types.ts";

/**
 * 通过变量形式的模块标识符加载 OAuth 流程模块，避免打包器追踪导入并将其解析到仅适用于 Node 的流程代码中
 *（例如依赖 `node:http` 的回调服务器和依赖 `node:crypto` 的 PKCE 实现）。将 `.ts` 改写为 `.js` 的处理
 * 可确保此技巧在源码和构建产物中均有效。
 */
const importOAuthModule = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

type OAuthFlowLoaders = {
	anthropic: () => OAuthAuth | Promise<OAuthAuth>;
	openaiCodex: () => OAuthAuth | Promise<OAuthAuth>;
	openaiChatGPT: () => OAuthAuth | Promise<OAuthAuth>;
	githubCopilot: () => OAuthAuth | Promise<OAuthAuth>;
	openrouter: () => OAuthAuth | Promise<OAuthAuth>;
	kimiCoding: () => OAuthAuth | Promise<OAuthAuth>;
	meta: () => OAuthAuth | Promise<OAuthAuth>;
	xai: () => OAuthAuth | Promise<OAuthAuth>;
	radius: (options: { name: string; gateway: string }) => OAuthAuth | Promise<OAuthAuth>;
};

let bundledLoaders: OAuthFlowLoaders | undefined;

/** 为独立 Bun 二进制文件注册静态打包的 OAuth 流程。 */
export function registerBundledOAuthFlowLoaders(loaders: OAuthFlowLoaders): void {
	bundledLoaders = loaders;
}

export const loadAnthropicOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.anthropic();
	return ((await importOAuthModule("./anthropic.ts")) as { anthropicOAuth: OAuthAuth }).anthropicOAuth;
};

export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.openaiCodex();
	return ((await importOAuthModule("./openai-codex.ts")) as { openaiCodexOAuth: OAuthAuth }).openaiCodexOAuth;
};

export const loadOpenAIChatGPTOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.openaiChatGPT();
	return ((await importOAuthModule("./openai-chatgpt.ts")) as { openaiChatGPTOAuth: OAuthAuth }).openaiChatGPTOAuth;
};

export const loadGitHubCopilotOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.githubCopilot();
	return ((await importOAuthModule("./github-copilot.ts")) as { githubCopilotOAuth: OAuthAuth }).githubCopilotOAuth;
};

export const loadOpenRouterOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.openrouter();
	return ((await importOAuthModule("./openrouter.ts")) as { openRouterOAuth: OAuthAuth }).openRouterOAuth;
};

export const loadKimiCodingOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.kimiCoding();
	return ((await importOAuthModule("./kimi-coding.ts")) as { kimiCodingOAuth: OAuthAuth }).kimiCodingOAuth;
};

export const loadMetaOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.meta();
	return ((await importOAuthModule("./meta.ts")) as { metaOAuth: OAuthAuth }).metaOAuth;
};

export const loadXaiOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.xai();
	return ((await importOAuthModule("./xai.ts")) as { xaiOAuth: OAuthAuth }).xaiOAuth;
};

export const loadRadiusOAuth = async (options: { name: string; gateway: string }): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.radius(options);
	return (
		(await importOAuthModule("./radius.ts")) as {
			createRadiusOAuth: (input: { name: string; gateway: string }) => OAuthAuth;
		}
	).createRadiusOAuth(options);
};
