import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ImageProcessor } from "../tools/image-processor.ts";
import { createPhotonImages } from "./index.ts";

/**
 * 面向 Node 和 Bun 的 `createPhotonImages()`，Photon 的 WebAssembly 来自已安装的 `@silvia-odwyer/photon`。
 * 单文件二进制无法解析该包：请读取其自带的 `photon_rs_bg.wasm` 副本并调用 `createPhotonImages()`。
 */
export async function createNodePhotonImages(): Promise<ImageProcessor> {
	const path = createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm");
	return createPhotonImages(await readFile(path));
}
