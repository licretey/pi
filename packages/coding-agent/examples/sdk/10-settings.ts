/**
 * 设置配置
 *
 * 使用 SettingsManager 覆盖设置。
 */

import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();

// 加载当前设置（合并全局设置和项目设置）
const settingsManagerFromDisk = SettingsManager.create(cwd);
console.log("Current settings:", JSON.stringify(settingsManagerFromDisk.getGlobalSettings(), null, 2));

// 覆盖指定设置
const settingsManager = SettingsManager.create(cwd);
settingsManager.applyOverrides({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

const { session: customSettingsSession } = await createAgentSession({
	settingsManager,
	sessionManager: SessionManager.inMemory(),
});
console.log("Session created with custom settings");
customSettingsSession.dispose();

// setter 会立即更新内存，并将持久化写入加入队列。
// 需要确保数据持久化时，调用 flush()。
settingsManager.setDefaultThinkingLevel("low");
await settingsManager.flush();

// 在应用层处理设置读写错误。
const settingsErrors = settingsManager.drainErrors();
if (settingsErrors.length > 0) {
	for (const { scope, error } of settingsErrors) {
		console.warn(`Warning (${scope} settings): ${error.message}`);
	}
}

// 测试时可使用不涉及文件读写的内存设置：
const inMemorySettings = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

const { session: testSession } = await createAgentSession({
	settingsManager: inMemorySettings,
	sessionManager: SessionManager.inMemory(),
});
console.log("Test session created with in-memory settings");
testSession.dispose();
