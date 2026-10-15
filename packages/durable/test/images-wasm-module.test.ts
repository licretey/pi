// 单独放在此文件中，确保 Photon 尚未初始化：Vitest 为每个文件创建独立模块环境，而 Photon 只加载一次。
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createPhotonImages } from "@earendil-works/pi-durable/images";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { expect, it } from "vitest";

it("createPhotonImages takes a compiled WebAssembly module, as Cloudflare Workers pass it", async () => {
	const path = createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm");
	const { WebAssembly } = globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<object> } };
	const module = (await WebAssembly.compile(await readFile(path))) as Parameters<typeof createPhotonImages>[0];
	const images = createPhotonImages(module);
	// 1×1 GIF；只有成功解码后才会原样返回，因此未初始化 Photon 时该操作会失败。
	const data = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
	const prepared = await images.prepare(Buffer.from(data, "base64"), "image/gif", DEFAULT_IMAGE_LIMITS);
	expect(prepared).toEqual({ data, mimeType: "image/gif" });
});
