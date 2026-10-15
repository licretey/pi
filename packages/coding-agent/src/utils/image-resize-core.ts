import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // 默认值：2000。
	maxHeight?: number; // 默认值：2000。
	maxBytes?: number; // Base64 编码数据的默认上限为 4.5 MB（低于 Anthropic 的 5 MB 限制）。
	jpegQuality?: number; // 默认值：80。
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

/**
 * 图像缩放工作线程响应的标记。Node 也可能在工作线程通道上发送自己的消息
 *（例如 `node --watch` 下的 `{ "watch:require": [...] }`），因此必须能识别工作线程响应。
 */
export const IMAGE_RESIZE_WORKER_RESPONSE_TYPE = "pi:image-resize-response";

export type ResizeImageWorkerResponse =
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; result: ResizedImage | null }
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; error: string };

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * 缩放图像，使其符合指定的最大尺寸和编码后文件大小限制。
 * 如果无法将图像缩小到 maxBytes 以下，则返回 null。
 *
 * 使用 Photon（Rust/WASM）处理图像。Photon 不可用时返回 null。
 *
 * 控制在 maxBytes 限制内的策略：
 * 1. 先缩放至 maxWidth/maxHeight。
 * 2. 分别尝试 PNG 和 JPEG 格式，并选择较小的结果。
 * 3. 如果仍然过大，逐步降低 JPEG 质量并重试。
 * 4. 如果仍然过大，逐步缩小尺寸，直到 1x1。
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		// 检查图像是否已同时符合尺寸和编码后大小限制。
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// 计算符合最大尺寸限制的初始尺寸。
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		function tryEncodings(width: number, height: number, jpegQualities: number[]): EncodedCandidate[] {
			const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);

			try {
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				for (const quality of jpegQualities) {
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				return candidates;
			} finally {
				resized.free();
			}
		}

		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		while (true) {
			const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
			for (const candidate of candidates) {
				if (candidate.encodedSize < opts.maxBytes) {
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: currentWidth,
						height: currentHeight,
						wasResized: true,
					};
				}
			}

			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		return null;
	} finally {
		if (image) {
			image.free();
		}
	}
}
