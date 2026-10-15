/**
 * Photon 图像处理封装。
 *
 * 此模块为 @silvia-odwyer/photon-node 提供统一接口，支持：
 * 1. Node.js（开发环境、npm run build）
 * 2. Bun 编译后的二进制文件（独立分发版本）
 *
 * 问题在于：photon-node 的 CJS 入口使用 fs.readFileSync(__dirname + '/photon_rs_bg.wasm')，
 * 这会把构建机器上的绝对路径写入 Bun 编译后的二进制文件。
 *
 * 解决方案：
 * 1. 修补 fs.readFileSync，将找不到 photon_rs_bg.wasm 时的读取重定向到备用位置。
 * 2. 在 build:binary 阶段将 photon_rs_bg.wasm 复制到可执行文件旁边。
 */

import type { PathOrFileDescriptor } from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");

// 从主包重新导出类型。
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

type ReadFileSync = typeof fs.readFileSync;

const WASM_FILENAME = "photon_rs_bg.wasm";

// 延迟加载的 photon 模块。
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

function pathOrNull(file: PathOrFileDescriptor): string | null {
	if (typeof file === "string") {
		return file;
	}
	if (file instanceof URL) {
		return fileURLToPath(file);
	}
	return null;
}

function getFallbackWasmPaths(): string[] {
	const execDir = path.dirname(process.execPath);
	return [
		path.join(execDir, WASM_FILENAME),
		path.join(execDir, "photon", WASM_FILENAME),
		path.join(process.cwd(), WASM_FILENAME),
	];
}

function patchPhotonWasmRead(): () => void {
	const originalReadFileSync: ReadFileSync = fs.readFileSync.bind(fs);
	const fallbackPaths = getFallbackWasmPaths();
	const mutableFs = fs as { readFileSync: ReadFileSync };

	const patchedReadFileSync: ReadFileSync = ((...args: Parameters<ReadFileSync>) => {
		const [file, options] = args;
		const resolvedPath = pathOrNull(file);

		if (resolvedPath?.endsWith(WASM_FILENAME)) {
			try {
				return originalReadFileSync(...args);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err?.code && err.code !== "ENOENT") {
					throw error;
				}

				for (const fallbackPath of fallbackPaths) {
					if (!fs.existsSync(fallbackPath)) {
						continue;
					}
					if (options === undefined) {
						return originalReadFileSync(fallbackPath);
					}
					return originalReadFileSync(fallbackPath, options);
				}

				throw error;
			}
		}

		return originalReadFileSync(...args);
	}) as ReadFileSync;

	try {
		mutableFs.readFileSync = patchedReadFileSync;
	} catch {
		Object.defineProperty(fs, "readFileSync", {
			value: patchedReadFileSync,
			writable: true,
			configurable: true,
		});
	}

	return () => {
		try {
			mutableFs.readFileSync = originalReadFileSync;
		} catch {
			Object.defineProperty(fs, "readFileSync", {
				value: originalReadFileSync,
				writable: true,
				configurable: true,
			});
		}
	};
}

/**
 * 异步加载 photon 模块。
 * 后续调用会返回缓存的模块。
 */
export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
	if (photonModule) {
		return photonModule;
	}

	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		const restoreReadFileSync = patchPhotonWasmRead();
		try {
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch {
			photonModule = null;
			return photonModule;
		} finally {
			restoreReadFileSync();
		}
	})();

	return loadPromise;
}
