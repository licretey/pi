/** 仅在执行命令时加载 `pi mcp` 命令及 MCP 运行时（参见 cli.ts）。 */
export const loadMcpCommand = () => import("./cli.ts");
