import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import type { SettingsManager } from "./settings-manager.ts";

export function collectSettingsDiagnostics(settingsManager: SettingsManager): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, path, error }) => ({
		type: "warning",
		message: path ? `Invalid settings file ${path}: ${error.message}` : `Invalid ${scope} settings: ${error.message}`,
	}));
}

/**
 * 删除类型和消息均相同的重复诊断，同时保留首次出现的记录。
 * 启动阶段和运行时的设置管理器可能会报告同一个文件错误。
 */
export function deduplicateDiagnostics(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
