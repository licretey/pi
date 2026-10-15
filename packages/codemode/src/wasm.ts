import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * `quickjs-wasi/quickjs.wasm` 编译得到的 `WebAssembly.Module`。此处使用不透明类型，
 * 因为 Node 类型定义没有声明 WebAssembly 全局对象（这些定义位于 DOM 标准库中）。
 */
export type CodemodeWasmModule = object;

interface WebAssemblyGlobal {
	compile(bytes: Uint8Array): Promise<CodemodeWasmModule>;
}

const modules = new Map<string, Promise<CodemodeWasmModule>>();

/**
 * 按路径读取并编译 QuickJS wasm，每个路径只执行一次。`path` 默认为已安装的 `quickjs-wasi` 包中的文件；
 * 文件位于其他位置时应显式传入路径，例如文件被嵌入 Bun 编译的可执行文件时。
 * 加载失败后，下次调用会重试。
 */
export function loadQuickJSWasm(path?: string): Promise<CodemodeWasmModule> {
	const resolved = path ?? createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
	let module = modules.get(resolved);
	if (!module) {
		const { WebAssembly } = globalThis as unknown as { WebAssembly: WebAssemblyGlobal };
		module = readFile(resolved)
			.then((bytes) => WebAssembly.compile(bytes))
			.catch((error: unknown) => {
				modules.delete(resolved);
				throw error;
			});
		modules.set(resolved, module);
	}
	return module;
}
