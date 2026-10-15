/**
 * Codemode、工具搜索与 MCP
 *
 * CLI 会将 `codemode`、`tool_search` 和 MCP 作为内置扩展加载。SDK 会话需将它们
 * 添加到资源加载器的扩展工厂中。
 *
 * `codemode` 和 `tool_search` 注册后默认处于未启用状态。可通过 `defaultTools` 设置启用它们
 *（使用 `tools` 还会将会话限制为指定工具，导致 MCP 工具不可见），也可以由 MCP 扩展按需启用：
 * 对公开 `codemode` 的服务器启用 `codemode`，对公开 `deferred` 的服务器启用 `tool_search`。
 */

import {
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();

const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir: getAgentDir(),
	extensionFactories: [
		createCodemodeExtension({ mode: "on" }),
		createToolSearchExtension(),
		// 与 CLI 一样，从 agent 目录和受信任项目中读取 mcp.json。
		createMcpExtension(),
	],
});
await resourceLoader.reload();

const settingsManager = SettingsManager.create(cwd);
// `+name` 会在已配置的默认工具上追加工具，而不是替换默认工具。
settingsManager.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] });

const { session } = await createAgentSession({
	resourceLoader,
	settingsManager,
	sessionManager: SessionManager.inMemory(),
});

try {
	// 发出 session_start 事件，并在后台连接 MCP 服务器。
	await session.bindExtensions({});
	console.log("Active tools:", session.getActiveToolNames().join(", "));
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
	await session.prompt("Use codemode to count the TypeScript files in src/ and list the three largest.");
	console.log();
} finally {
	session.dispose();
}
