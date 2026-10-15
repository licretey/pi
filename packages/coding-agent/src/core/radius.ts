import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@earendil-works/pi-ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
export const ENV_RADIUS_GATEWAY = "PI_RADIUS_GATEWAY";
/** 内置 Radius 提供商登录所用网关的 MCP 端点。 */
export const RADIUS_MCP_URL = `${normalizeRadiusGatewayUrl(DEFAULT_RADIUS_GATEWAY)}/mcp`;

/** Radius 网关源地址；若设置了 `PI_RADIUS_GATEWAY`，则使用其覆盖值。 */
export function getRadiusGatewayUrl(): string {
	return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);
}
