export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface UnauthorizedContext {
	/** 401 响应，或质询中报告 `insufficient_scope` 的 403 响应。 */
	response: Response;
	serverUrl: URL;
	fetch: McpFetch;
	/** 被拒绝请求携带的访问令牌（如果有）。若当前令牌不同，表示其他请求已完成刷新。 */
	token?: string;
}

/** 为 MCP HTTP 传输提供 Bearer 令牌，并可在收到 401 响应后刷新令牌。 */
export interface AuthProvider {
	/**
	 * 获取下一个请求使用的令牌。此操作可能先通过网络刷新令牌，因此传输层只会在等待响应的请求发送前调用。
	 * 关闭会话时会复用最后一个请求使用的令牌。
	 */
	token(): Promise<string | undefined>;
	onUnauthorized?(context: UnauthorizedContext): Promise<void>;
}
