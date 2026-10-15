/** 模型看到的图像必须遵守的限制；以下默认值来自编码代理。 */
export type ImageLimits = {
	/** 像素。默认 2000。 */
	readonly maxWidth: number;
	/** 像素。默认 2000。 */
	readonly maxHeight: number;
	/** base64 字节数。默认 4.5 MiB，低于 Anthropic 的 5 MB。 */
	readonly maxBytes: number;
};

export const DEFAULT_IMAGE_LIMITS: ImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };

/** 模型可接收的图像：受支持的格式、在限制之内、以 base64 表示。 */
export type PreparedImage = {
	readonly data: string;
	readonly mimeType: string;
	/** 图像被缩放时设置：缩放前后的尺寸，供模型把坐标映射回去。 */
	readonly resized?: {
		readonly from: { readonly width: number; readonly height: number };
		readonly to: { readonly width: number; readonly height: number };
	};
	/** 原始格式，与 `mimeType` 不同时设置：BMP 转为 PNG，较大的 PNG 可能转为 JPEG。 */
	readonly convertedFrom?: string;
};

/**
 * 解码、定向、缩放并重新编码图像，使模型能够接收。`read` 在提供处理器时使用它；没有时，会把字节限制之内的
 * 受支持图像原样放行。`@earendil-works/pi-durable/images` 提供基于 Photon 的实现。
 */
export type ImageProcessor = {
	/**
	 * 已按 `limits` 准备好的图像，或无法解码/无法缩减到限制之内时的 `undefined`。返回 promise，
	 * 因此处理器可以把工作放到事件循环之外。
	 */
	prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined>;
};

/** 所有提供方都直接内联接收的格式；其他格式（如 BMP）需要转换。 */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `bytes` 的标准 base64，不依赖 `Buffer` 或 `btoa` 等平台 API。 */
export function toBase64(bytes: Uint8Array): string {
	const parts: string[] = [];
	let chunk = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i]!;
		const b = bytes[i + 1];
		const c = bytes[i + 2];
		chunk += BASE64[a >> 2]!;
		chunk += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
		chunk += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
		chunk += c === undefined ? "=" : BASE64[c & 63]!;
		// 分段拼接：一次增长一个字符的字符串在兆字节量级下很慢。
		if (chunk.length >= 8192) {
			parts.push(chunk);
			chunk = "";
		}
	}
	parts.push(chunk);
	return parts.join("");
}

/** `byteLength` 个字节对应的 base64 长度。 */
export function base64Length(byteLength: number): number {
	return Math.ceil(byteLength / 3) * 4;
}
