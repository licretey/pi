/** 首次使用时才加载 MCP 客户端、传输层和 OAuth 登录逻辑（参见 runtime.ts）。 */
export const loadMcpRuntime = () => import("./runtime.ts");
