/**
 * 工具配置
 *
 * 通过工具名称选择要启用的内置工具。
 *
 * 工具名称会与所有可用工具进行匹配。使用自定义 `cwd` 时，
 * createAgentSession() 会在创建实际的内置工具时应用该目录。
 *
 * 有关自定义工具，请参见 06-extensions.ts；自定义工具通过扩展系统中的
 * pi.registerTool() 注册。
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// 只读模式（不启用 edit/write）
const { session: readOnlySession } = await createAgentSession({
	tools: ["read", "grep", "find", "ls"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Read-only session created");
readOnlySession.dispose();

// 自定义工具选择
const { session: customToolsSession } = await createAgentSession({
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Custom tools session created");
customToolsSession.dispose();

// 使用自定义 cwd
const customCwd = "/path/to/project";
const { session: customCwdSession } = await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "edit", "write"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Custom cwd session created");
customCwdSession.dispose();

// 也可以为自定义 cwd 指定具体工具
const { session: specificToolsSession } = await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Specific tools with custom cwd session created");
specificToolsSession.dispose();
