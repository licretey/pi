// Wrangler 默认的 `CompiledWasm` 规则会把该导入变成一个 `WebAssembly.Module`；Workers 无法在运行时从字节编译
// WebAssembly。其他打包器不支持这一点：在那些环境下请使用 `createPhotonImages()`。
import photonWasm from "@silvia-odwyer/photon/photon_rs_bg.wasm";
import type { ImageProcessor } from "../tools/image-processor.ts";
import { createPhotonImages } from "./index.ts";

/** 面向 Cloudflare Workers 和 Durable Objects 的 `createPhotonImages()`，需用 Wrangler 构建。 */
export function createCloudflarePhotonImages(): ImageProcessor {
	return createPhotonImages(photonWasm);
}
