/*
 * 改编自 modelcontextprotocol/typescript-sdk v1.29.0 的 src/client/auth.ts。
 * 版权所有 (c) 2024 Anthropic, PBC。依据 MIT 许可证授权；详见 LICENSES/。
 * 修改为移除 Zod/CORS 兼容层，并强制校验授权服务器发行者。
 */

import type { McpFetch } from "../auth-provider.ts";
import { LATEST_PROTOCOL_VERSION } from "../protocol/types.ts";
import { OAuthIssuerMismatchError } from "./errors.ts";
import {
	type AuthorizationServerMetadata,
	type OAuthChallenge,
	type OAuthProtectedResourceMetadata,
	type OAuthServerInfo,
	parseAuthorizationServerMetadata,
	parseProtectedResourceMetadata,
} from "./types.ts";

function discard(response: Response | undefined): void {
	void response?.body?.cancel().catch(() => {});
}

/** 4xx 和 502 表示当前地址没有所需资源，因此发现流程会尝试下一个候选 URL。 */
function isDiscoveryMiss(status: number): boolean {
	return (status >= 400 && status < 500) || status === 502;
}

/** `/.well-known/<kind><path>` 的路径后缀；根路径对应空字符串。 */
function pathSuffix(pathname: string): string {
	return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function field(header: string, name: string): string | undefined {
	const match = header.match(new RegExp(String.raw`(?:^|[,\s])${name}=(?:"([^"]*)"|([^\s,]+))`, "i"));
	// 空值（`scope=""`）不包含任何信息，因此视为未提供。
	return match?.[1] || match?.[2] || undefined;
}

export function parseWwwAuthenticate(header: string | null): OAuthChallenge {
	if (!header) return {};
	const scheme = header.trimStart().split(/\s+/, 1)[0]?.toLowerCase();
	if (scheme !== "bearer" && scheme !== "dpop") return {};
	const resourceMetadata = field(header, "resource_metadata");
	let resourceMetadataUrl: URL | undefined;
	if (resourceMetadata) {
		try {
			resourceMetadataUrl = new URL(resourceMetadata);
		} catch {}
	}
	return {
		resourceMetadataUrl,
		scope: field(header, "scope"),
		error: field(header, "error"),
		errorDescription: field(header, "error_description"),
	};
}

async function fetchMetadata(
	url: URL,
	fetch: McpFetch,
	protocolVersion: string,
	signal: AbortSignal | undefined,
): Promise<Response> {
	return fetch(url, {
		headers: { Accept: "application/json", "MCP-Protocol-Version": protocolVersion },
		signal,
	});
}

export async function discoverProtectedResourceMetadata(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: string | URL;
		protocolVersion?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	} = {},
): Promise<OAuthProtectedResourceMetadata> {
	const server = new URL(serverUrl);
	const fetch = options.fetch ?? globalThis.fetch;
	const version = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
	let response = await fetchMetadata(
		options.resourceMetadataUrl
			? new URL(options.resourceMetadataUrl)
			: new URL(`/.well-known/oauth-protected-resource${pathSuffix(server.pathname)}`, server.origin),
		fetch,
		version,
		options.signal,
	);
	if (!options.resourceMetadataUrl && server.pathname !== "/" && isDiscoveryMiss(response.status)) {
		discard(response);
		response = await fetchMetadata(
			new URL("/.well-known/oauth-protected-resource", server.origin),
			fetch,
			version,
			options.signal,
		);
	}
	if (!response.ok) {
		discard(response);
		throw new Error(`HTTP ${response.status} loading OAuth protected resource metadata`);
	}
	return parseProtectedResourceMetadata(await response.json());
}

export function buildAuthorizationServerDiscoveryUrls(
	authorizationServerUrl: string | URL,
): { url: URL; type: "oauth" | "oidc" }[] {
	const issuer = new URL(authorizationServerUrl);
	const path = pathSuffix(issuer.pathname);
	const urls: { url: URL; type: "oauth" | "oidc" }[] = [
		{ url: new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin), type: "oauth" },
		{ url: new URL(`/.well-known/openid-configuration${path}`, issuer.origin), type: "oidc" },
	];
	if (path) urls.push({ url: new URL(`${path}/.well-known/openid-configuration`, issuer.origin), type: "oidc" });
	return urls;
}

export async function discoverAuthorizationServerMetadata(
	authorizationServerUrl: string | URL,
	options: { fetch?: McpFetch; protocolVersion?: string; skipIssuerValidation?: boolean; signal?: AbortSignal } = {},
): Promise<AuthorizationServerMetadata | undefined> {
	const fetch = options.fetch ?? globalThis.fetch;
	for (const { url } of buildAuthorizationServerDiscoveryUrls(authorizationServerUrl)) {
		const response = await fetchMetadata(
			url,
			fetch,
			options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
			options.signal,
		);
		if (!response.ok) {
			discard(response);
			if (isDiscoveryMiss(response.status)) continue;
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(await response.json());
		if (!options.skipIssuerValidation) {
			const expected = String(authorizationServerUrl);
			// URL 解析会为不带路径的源添加尾部斜杠，因此比较前先去掉两侧的尾部斜杠。
			const trim = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value);
			if (trim(metadata.issuer) !== trim(expected)) throw new OAuthIssuerMismatchError(expected, metadata.issuer);
		}
		return metadata;
	}
	return undefined;
}

export async function discoverOAuthServerInfo(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: URL;
		/** 用于替代发现流程的元数据文档。由于该文档由配置指定并直接信任，因此不会检查其 issuer。 */
		authorizationServerMetadataUrl?: URL;
		fetch?: McpFetch;
		skipIssuerValidation?: boolean;
		signal?: AbortSignal;
	} = {},
): Promise<OAuthServerInfo> {
	let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
	try {
		resourceMetadata = await discoverProtectedResourceMetadata(serverUrl, {
			resourceMetadataUrl: options.resourceMetadataUrl,
			fetch: options.fetch,
			signal: options.signal,
		});
	} catch (error) {
		if (error instanceof TypeError) throw error;
	}
	if (options.authorizationServerMetadataUrl) {
		const url = options.authorizationServerMetadataUrl;
		const response = await fetchMetadata(
			url,
			options.fetch ?? globalThis.fetch,
			LATEST_PROTOCOL_VERSION,
			options.signal,
		);
		if (!response.ok) {
			discard(response);
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(await response.json());
		return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata, resourceMetadata };
	}
	const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? String(new URL("/", serverUrl));
	return {
		authorizationServerUrl,
		authorizationServerMetadata: await discoverAuthorizationServerMetadata(authorizationServerUrl, {
			fetch: options.fetch,
			skipIssuerValidation: options.skipIssuerValidation,
			signal: options.signal,
		}),
		resourceMetadata,
	};
}

export function resourceUrlFromServerUrl(value: string | URL): URL {
	const url = new URL(value);
	url.hash = "";
	return url;
}

export function selectResource(serverUrl: string | URL, metadata?: OAuthProtectedResourceMetadata): string | undefined {
	if (!metadata) return undefined;
	const requested = resourceUrlFromServerUrl(serverUrl);
	const configured = new URL(metadata.resource);
	if (requested.origin !== configured.origin) {
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : `${requested.pathname}/`;
	const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`;
	if (!requestedPath.startsWith(configuredPath)) {
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	return metadata.resource;
}
