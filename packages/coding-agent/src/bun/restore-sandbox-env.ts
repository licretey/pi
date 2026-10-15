/**
 * 针对 https://github.com/oven-sh/bun/issues/27802 的兼容处理。
 *
 * Bun 编译后的二进制文件在沙箱环境（例如 Linux/macOS 上的 nono）中运行时，`process.env` 为空。
 * 在 Linux 上，可以从 `/proc/self/environ` 恢复环境变量。
 *
 * 请与 packages/ai/src/utils/provider-env.ts 中的 getBunSandboxEnvValue() 保持同步。
 * ai 包会重复实现此查找逻辑，以支持不经过 coding-agent 入口的直接使用方。
 */

import { readFileSync } from "node:fs";

/**
 * 在 Bun 的 `process.env` 为空的沙箱环境中运行时，从 `/proc/self/environ` 恢复环境变量。
 */
export function restoreSandboxEnv(): void {
	if (!process.versions?.bun) return;

	// 如果 process.env 中已有条目，则无需处理。
	if (Object.keys(process.env).length > 0) return;

	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				process.env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
	} catch {
		// /proc/self/environ 可能不可读，此时忽略错误。
	}
}
