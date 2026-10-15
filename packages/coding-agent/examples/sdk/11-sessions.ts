/**
 * 会话管理
 *
 * 控制会话持久化方式：使用内存、新建文件、继续最近会话或打开指定会话。
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// 使用内存（不持久化）
const { session: inMemory } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
});
console.log("In-memory session:", inMemory.sessionFile ?? "(none)");
inMemory.dispose();

// 新建持久化会话
const { session: newSession } = await createAgentSession({
	sessionManager: SessionManager.create(process.cwd()),
});
console.log("New session file:", newSession.sessionFile);
newSession.dispose();

// 继续最近的会话（不存在时新建）
const { session: continued, modelFallbackMessage } = await createAgentSession({
	sessionManager: SessionManager.continueRecent(process.cwd()),
});
if (modelFallbackMessage) console.log("Note:", modelFallbackMessage);
console.log("Continued session:", continued.sessionFile);
continued.dispose();

// 列出会话并打开指定会话
const sessions = await SessionManager.list(process.cwd());
console.log(`\nFound ${sessions.length} sessions:`);
for (const info of sessions.slice(0, 3)) {
	console.log(`  ${info.id.slice(0, 8)}... - "${info.firstMessage.slice(0, 30)}..."`);
}

if (sessions.length > 0) {
	const { session: opened } = await createAgentSession({
		sessionManager: SessionManager.open(sessions[0].path),
	});
	console.log(`\nOpened: ${opened.sessionId}`);
	opened.dispose();
}

// 自定义会话目录（路径中不编码 cwd）
// const customDir = "/path/to/my-sessions";
// const { session } = await createAgentSession({
//   sessionManager: SessionManager.create(process.cwd(), customDir),
// });
// SessionManager.list(process.cwd(), customDir);
// SessionManager.continueRecent(process.cwd(), customDir);
