/**
 * 自定义系统提示。
 *
 * 演示如何替换或修改默认系统提示词。
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
const agentDir = getAgentDir();

// 方式一：完全替换提示词。
const loader1 = new DefaultResourceLoader({
	cwd,
	agentDir,
	systemPromptOverride: () => `You are a helpful assistant that speaks like a pirate.
Always end responses with "Arrr!"`,
	// 避免 DefaultResourceLoader 将 ~/.pi/agent 或 <cwd>/.pi 中的 APPEND_SYSTEM.md 追加到提示词。
	appendSystemPromptOverride: () => [],
});
await loader1.reload();

const { session: session1 } = await createAgentSession({
	resourceLoader: loader1,
	sessionManager: SessionManager.inMemory(),
});

try {
	session1.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log("=== Replace prompt ===");
	await session1.prompt("What is 2 + 2?");
	console.log("\n");
} finally {
	session1.dispose();
}

// 方式二：在默认提示词后追加指令。
const loader2 = new DefaultResourceLoader({
	cwd,
	agentDir,
	appendSystemPromptOverride: (base) => [
		...base,
		"## Additional Instructions\n- Always be concise\n- Use bullet points when listing things",
	],
});
await loader2.reload();

const { session: session2 } = await createAgentSession({
	resourceLoader: loader2,
	sessionManager: SessionManager.inMemory(),
});

try {
	session2.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log("=== Modify prompt ===");
	await session2.prompt("List 3 benefits of TypeScript.");
	console.log();
} finally {
	session2.dispose();
}
