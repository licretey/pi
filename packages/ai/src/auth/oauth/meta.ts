/**
 * Meta Model API OAuth 授权流程。
 *
 * 使用 RFC 8628 设备授权许可向 https://auth.meta.com 请求授权（返回 JSON）。Meta 将身份认证与 API 访问分开：
 * 获得的身份 token 不能用于推理，因此需要通过 Muse Code 密钥签发端点将其兑换为 Model API 密钥
 *（签发的密钥约一天后过期）。身份 token 存储在 `refresh` 字段，签发的密钥存储在 `access` 字段，
 * 因此标准 OAuth 调度器会在密钥过期时重新签发，无需额外的续期逻辑。身份 token 本身不可续期
 *（auth.meta.com 会对 grant_type=refresh_token 返回 404，且不会签发 refresh_token），所以密钥签发请求返回 401/403
 * 表示会话已失效，用户必须重新登录。
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

// Muse Code CLI 客户端 ID。
const CLIENT_ID = "1031625952748946";
const AUTH_HOST = "https://auth.meta.com";
const DEVICE_AUTHORIZATION_URL = `${AUTH_HOST}/oidc/device/authorization/`;
const DEVICE_TOKEN_URL = `${AUTH_HOST}/oidc/device/token/`;
const API_KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
const API_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

type DeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
};

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const json = await response.json();
		return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function errorDetail(json: Record<string, unknown> | null): string {
	for (const key of ["error_description", "detail", "message", "error"]) {
		const value = json?.[key];
		if (typeof value === "string" && value.trim()) return `: ${value.trim()}`;
	}
	return "";
}

/** 验证 URI 会在用户的浏览器中打开；仅信任 http(s) URL。 */
function trustedHttpUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.href;
	} catch {
		return null;
	}
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function startDeviceAuthorization(signal: AbortSignal): Promise<DeviceAuthorization> {
	const response = await fetch(DEVICE_AUTHORIZATION_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
		signal: requestSignal(signal),
	});
	const json = await readJson(response);
	if (!response.ok) {
		throw new Error(`Meta device authorization failed with status ${response.status}${errorDetail(json)}`);
	}
	const deviceCode = json?.device_code;
	const userCode = json?.user_code;
	const verificationUri = trustedHttpUrl(json?.verification_uri_complete) ?? trustedHttpUrl(json?.verification_uri);
	if (typeof deviceCode !== "string" || !deviceCode || typeof userCode !== "string" || !userCode || !verificationUri) {
		throw new Error(`Invalid Meta device authorization response: ${JSON.stringify(json)}`);
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		intervalSeconds: positiveNumber(json?.interval),
		expiresInSeconds: positiveNumber(json?.expires_in),
	};
}

async function pollForIdentityToken(device: DeviceAuthorization, signal: AbortSignal): Promise<string> {
	return pollOAuthDeviceCodeFlow<string>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await fetch(DEVICE_TOKEN_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: new URLSearchParams({
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: device.deviceCode,
					client_id: CLIENT_ID,
				}).toString(),
				signal: requestSignal(signal),
			});
			const json = await readJson(response);
			if (response.ok && typeof json?.access_token === "string" && json.access_token) {
				return { status: "complete", value: json.access_token };
			}
			switch (json?.error) {
				case "authorization_pending":
					return { status: "pending" };
				case "slow_down":
					return { status: "slow_down", intervalSeconds: positiveNumber(json?.interval) };
				case "access_denied":
					return { status: "failed", message: "Meta login was denied." };
				case "expired_token":
					return { status: "failed", message: "Meta device authorization expired. Please restart login." };
				default:
					return {
						status: "failed",
						message: `Meta device token request failed with status ${response.status}${errorDetail(json)}`,
					};
			}
		},
	});
}

/** 使用身份令牌换取模型 API 密钥。密钥有效期约为一天。 */
async function mintApiKey(identityToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await fetch(API_KEY_MINT_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${identityToken}`,
			"Content-Type": "application/json",
			"x-api-version": "1.0.0",
		},
		body: "{}",
		signal: requestSignal(signal),
	});
	const json = await readJson(response);
	if (response.status === 401 || response.status === 403) {
		// 身份 token 不可续期（参见文件头部说明）；只能重新执行设备授权流程。
		throw new Error(
			`Meta session expired (status ${response.status}). Run \`/login meta\` to sign in again.${errorDetail(json)}`,
		);
	}
	if (!response.ok) {
		throw new Error(`Meta API key mint failed with status ${response.status}${errorDetail(json)}`);
	}
	const apiKey = json?.api_key;
	if (typeof apiKey !== "string" || !apiKey) {
		const actionUrl = trustedHttpUrl(json?.action_url);
		throw new Error(`Meta did not issue an API key.${actionUrl ? ` Complete setup at ${actionUrl}` : ""}`);
	}
	return { type: "oauth", refresh: identityToken, access: apiKey, expires: Date.now() + API_KEY_LIFETIME_MS };
}

async function loginMeta(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	try {
		const device = await startDeviceAuthorization(interaction.signal);
		interaction.notify({
			type: "device_code",
			userCode: device.userCode,
			verificationUri: device.verificationUri,
			intervalSeconds: device.intervalSeconds,
			expiresInSeconds: device.expiresInSeconds,
		});
		const identityToken = await pollForIdentityToken(device, interaction.signal);
		interaction.notify({ type: "progress", message: "Enabling Meta Model API access..." });
		return await mintApiKey(identityToken, interaction.signal);
	} catch (e) {
		// 正在执行的 fetch 中止时会以 DOMException 拒绝；登录界面会根据此消息进行识别。
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		throw e;
	}
}

export const metaOAuth: OAuthAuth = {
	name: "Meta (Muse subscription)",
	isSubscription: true,
	loginLabel: "Sign in with Meta",

	login: loginMeta,

	refresh: (credential, signal) => mintApiKey(credential.refresh, signal),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
