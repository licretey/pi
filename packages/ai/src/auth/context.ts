import type { AuthContext } from "./types.ts";

interface NodeFsModule {
	access(path: string): Promise<void>;
}

interface NodeOsModule {
	homedir(): string;
}

// 使用变量形式的模块标识符，避免浏览器打包器尝试解析 Node 内置模块。
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

function getProcessEnv(): Record<string, string | undefined> | undefined {
	const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	return proc?.env;
}

/**
 * 默认认证上下文：环境变量来自 `process.env`（浏览器中为 undefined），
 * 文件存在性通过 node:fs 查询（浏览器中始终返回 false）。
 */
export function defaultProviderAuthContext(): AuthContext {
	return {
		async env(name: string): Promise<string | undefined> {
			const value = getProcessEnv()?.[name];
			return typeof value === "string" && value.trim().length > 0 ? value : undefined;
		},

		async fileExists(path: string): Promise<boolean> {
			try {
				const fs = (await importNodeModule("node:fs/promises")) as NodeFsModule;
				let resolved = path;
				if (resolved.startsWith("~")) {
					const os = (await importNodeModule("node:os")) as NodeOsModule;
					resolved = os.homedir() + resolved.slice(1);
				}
				await fs.access(resolved);
				return true;
			} catch {
				return false;
			}
		},
	};
}
