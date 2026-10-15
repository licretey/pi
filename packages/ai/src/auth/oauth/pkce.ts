/**
 * 使用 Web Crypto API 的 PKCE 工具函数。
 * 同时适用于 Node.js 20 及更高版本和浏览器。
 */

/**
 * 将字节编码为 base64url 字符串。
 */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * 生成 PKCE code verifier 和 challenge。
 * 使用 Web Crypto API 以兼容不同平台。
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// 生成随机 verifier。
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// 计算 SHA-256 challenge。
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}
