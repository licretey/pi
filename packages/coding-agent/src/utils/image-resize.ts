import { Worker } from "node:worker_threads";
import {
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ResizedImage,
	type ResizeImageWorkerResponse,
	resizeImageInProcess,
} from "./image-resize-core.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	// 转移操作会分离缓冲区，因此转移工作线程持有的副本，保留调用方的原始字节。
	return new Uint8Array(input);
}

function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	return (
		value !== null && typeof value === "object" && "type" in value && value.type === IMAGE_RESIZE_WORKER_RESPONSE_TYPE
	);
}

function createResizeWorker(workerSpecifier: string | URL): Worker {
	return new Worker(workerSpecifier);
}

async function resizeImageInWorker(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const worker = createResizeWorker(workerSpecifier);
	try {
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		return await new Promise<ResizedImage | null>((resolve, reject) => {
			let settled = false;
			const settle = (result: ResizedImage | null): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			worker.on("message", (message: unknown) => {
				// 忽略 Node 自身在工作线程通道上发送的消息，例如 `node --watch` 下的
				// `{ "watch:require": [...] }`（nodejs/node#65044）。
				if (!isResizeImageWorkerResponse(message)) return;
				if ("error" in message) fail(new Error(message.error));
				else settle(message.result);
			});
			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			worker.postMessage(
				{
					inputBytes: inputBytesForWorker,
					mimeType,
					options,
				},
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		void worker.terminate().catch(() => undefined);
	}
}

/**
 * 缩放图像，使其符合指定的最大尺寸和编码后文件大小限制。
 * 在工作线程中运行 Photon，避免 WASM 解码、缩放和编码阻塞 TUI 事件循环。如果无法加载工作线程
 *（例如某些 Bun 编译后的可执行文件布局），则回退到进程内缩放，确保仍可读取图像。
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	const workerUrl = new URL(
		isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js",
		import.meta.url,
	);

	// Bun 编译后的可执行文件通过字符串路径解析工作线程入口，而不是通过
	// new URL(..., import.meta.url) 解析。在 Bun 下优先尝试字符串路径，使发布版二进制使用内嵌工作线程，避免回退到进程内执行。
	if (typeof process.versions.bun === "string") {
		try {
			return await resizeImageInWorker("./src/utils/image-resize-worker.ts", inputBytes, mimeType, options);
		} catch {}
	}

	try {
		return await resizeImageInWorker(workerUrl, inputBytes, mimeType, options);
	} catch {
		return resizeImageInProcess(inputBytes, mimeType, options);
	}
}

/**
 * 为缩放后的图像生成尺寸说明。
 * 帮助模型理解坐标映射关系。
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
