/**
 * 上下文文件（AGENTS.md）
 *
 * 上下文文件提供项目专属指令，这些指令会加载到系统提示词中。
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// 在 agentsFilesOverride 中返回空列表，即可完全禁用上下文文件。
const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	agentsFilesOverride: (current) => ({
		agentsFiles: [
			...current.agentsFiles,
			{
				path: "/virtual/AGENTS.md",
				content: `# Project Guidelines

## Code Style
- Use TypeScript strict mode
- No any types
- Prefer const over let`,
			},
		],
	}),
});
await loader.reload();

// 从 cwd 开始向上查找 AGENTS.md 文件
const discovered = loader.getAgentsFiles().agentsFiles;
console.log("Discovered context files:");
for (const file of discovered) {
	console.log(`  - ${file.path} (${file.content.length} chars)`);
}

const { session } = await createAgentSession({
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});
console.log(`Session created with ${discovered.length + 1} context files`);
session.dispose();
