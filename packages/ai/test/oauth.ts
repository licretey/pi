/**
 * 用于从 ~/.pi/agent/auth.json 解析 API 密钥的测试辅助函数。
 *
 * 同时支持 API 密钥和 OAuth 凭据。
 * OAuth 令牌过期时会自动刷新，并写回 auth.json。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { OAuthCredentials } from "../src/auth/types.ts";
import { builtinProviders } from "../src/providers/all.ts";

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorage = Record<string, AuthCredential>;

function loadAuthStorage(): AuthStorage {
	if (!existsSync(AUTH_PATH)) {
		return {};
	}
	try {
		const content = readFileSync(AUTH_PATH, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function saveAuthStorage(storage: AuthStorage): void {
	const configDir = dirname(AUTH_PATH);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(AUTH_PATH, JSON.stringify(storage, null, 2), "utf-8");
	chmodSync(AUTH_PATH, 0o600);
}

/**
 * 从 ~/.pi/agent/auth.json 中解析指定提供商的 API 密钥。
 *
 * API 密钥凭据会直接返回密钥。
 * OAuth 凭据会返回访问令牌；若令牌过期则先刷新并写回文件。
 *
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	const storage = loadAuthStorage();
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		const oauth = builtinProviders().find((candidate) => candidate.id === provider)?.auth.oauth;
		if (!oauth) return undefined;
		let credential = entry;
		try {
			if (Date.now() >= credential.expires) {
				credential = await oauth.refresh(credential, new AbortController().signal);
			}
		} catch (error) {
			console.log(JSON.stringify(error));
			return undefined;
		}
		storage[provider] = credential;
		saveAuthStorage(storage);
		return (await oauth.toAuth(credential)).apiKey;
	}

	return undefined;
}
