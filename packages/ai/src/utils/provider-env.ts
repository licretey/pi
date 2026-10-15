import type { ProviderEnv } from "../types.ts";

let procEnvCache: Map<string, string> | null = null;

/**
 * 针对 https://github.com/oven-sh/bun/issues/27802 的兜底方案。
 * Bun 编译出的二进制在 Linux 沙箱中可能暴露空的 process.env，
 * 尽管 /proc/self/environ 里包含完整环境。
 *
 * 这里有意复刻了 packages/coding-agent/src/bun/restore-sandbox-env.ts 中的
 * restoreSandboxEnv()。由于 ai 包可以被直接使用、而不经过那个入口，
 * 提供商环境变量查找不能依赖 process.env 已被修补。
 */
function getBunSandboxEnvValue(name: string): string | undefined {
	if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) {
		return undefined;
	}

	if (procEnvCache === null) {
		procEnvCache = new Map();
		try {
			const { readFileSync } = require("node:fs") as {
				readFileSync(path: string, encoding: BufferEncoding): string;
			};
			const data = readFileSync("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) {
					procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// /proc/self/environ 可能不存在或不可读。
		}
	}

	return procEnvCache.get(name);
}

/**
 * 解析提供商环境变量值：先查作用域覆盖，再查常规 process.env，
 * 最后用为直接使用 pi-ai 的消费者准备的 Bun 沙箱兜底逻辑。
 */
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return (
		env?.[name] ||
		(typeof process !== "undefined" ? process.env[name] : undefined) ||
		getBunSandboxEnvValue(name) ||
		undefined
	);
}
