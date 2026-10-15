// 该包只声明了 `module` 入口，打包器使用它而 Node 不会：请自行导入该文件。
import {
	fliph,
	flipv,
	initSync,
	PhotonImage,
	resize,
	SamplingFilter,
	type SyncInitInput,
} from "@silvia-odwyer/photon/photon_rs.js";
import type { ImageLimits, ImageProcessor, PreparedImage } from "../tools/image-processor.ts";
import { base64Length, INLINE_IMAGE_TYPES, toBase64 } from "../tools/image-processor.ts";
import { exifOrientation } from "./exif.ts";

/** 依次尝试的 JPEG 质量列表。 */
const JPEG_QUALITIES = [80, 70, 55, 40];

/**
 * 基于 Photon（Rust 编译为 WebAssembly）的 `ImageProcessor`，供 `createCodingTools({ images })` 使用。`wasm` 是
 * Photon 的 `photon_rs_bg.wasm`，以字节或已编译模块的形式提供：`@earendil-works/pi-durable/images/node` 会从
 * 已安装的包中读取它，`@earendil-works/pi-durable/images/cloudflare` 则将其作为 Workers 模块导入。在其他环境
 * （如浏览器）中，请自行 fetch 该文件并传入其字节。Photon 每个进程只加载一次；后续调用会复用第一次的 `wasm`。
 *
 * 已摆正、属于提供方可内联的格式、且在限制范围之内的图片，只要能解码就原样返回。否则会依据其 EXIF 方向摆正，
 * 缩放到最大宽高，以递减的质量编码为 PNG 或 JPEG（JPEG 源优先尝试 JPEG），然后按每次 3/4 缩小尺寸，
 * 直到 base64 装得下为止。提供方不能内联的格式（BMP）会转为 PNG。
 *
 * 这些工作在调用线程上执行：一张 1200 万像素的照片约需一秒半。解码会占用图像 RGBA 大小的 WebAssembly 内存，
 * 且不会归还；在内存受限的主机上请不要带上该处理器。
 */
export function createPhotonImages(wasm: SyncInitInput): ImageProcessor {
	initSync({ module: wasm });
	return { prepare: async (bytes, mimeType, limits) => prepare(bytes, mimeType, limits) };
}

function prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): PreparedImage | undefined {
	const orientation = exifOrientation(bytes);
	const inline = INLINE_IMAGE_TYPES.has(mimeType);
	let image: PhotonImage | undefined;
	try {
		// 即使原样返回也要先解码：损坏的文件是错误，而不是会被提供方拒绝的图像。
		image = PhotonImage.new_from_byteslice(bytes);
		if (
			inline &&
			orientation === 1 &&
			image.get_width() <= limits.maxWidth &&
			image.get_height() <= limits.maxHeight &&
			base64Length(bytes.byteLength) <= limits.maxBytes
		) {
			return { data: toBase64(bytes), mimeType };
		}
		if (orientation >= 5) {
			const upright = transposed(image, orientation);
			// 先释放，以便摆正后的副本复用其 WebAssembly 内存。
			image.free();
			image = undefined;
			image = new PhotonImage(upright.pixels, upright.width, upright.height);
		} else if (orientation !== 1) {
			if (orientation !== 4) fliph(image);
			if (orientation !== 2) flipv(image);
		}
		const width = image.get_width();
		const height = image.get_height();
		const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height);
		let target = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
		for (;;) {
			const encoded = encodeWithin(image, target, limits.maxBytes, mimeType === "image/jpeg");
			if (encoded !== undefined) {
				const resized =
					target.width === width && target.height === height
						? {}
						: { resized: { from: { width, height }, to: target } };
				const converted = encoded.mimeType === mimeType ? {} : { convertedFrom: mimeType };
				return { ...encoded, ...converted, ...resized };
			}
			if (target.width === 1 && target.height === 1) return undefined;
			target = {
				width: Math.max(1, Math.floor(target.width * 0.75)),
				height: Math.max(1, Math.floor(target.height * 0.75)),
			};
		}
	} catch {
		// Photon 对无法解码的字节会抛出异常。
		return undefined;
	} finally {
		image?.free();
	}
}

/**
 * 在首个 base64 能装进 `maxBytes` 的编码下输出 `size` 大小的 `image`：先 PNG，再按递减质量的 JPEG；
 * `jpegFirst` 时先试各 JPEG 质量；都不行则返回 `undefined`。
 */
function encodeWithin(
	image: PhotonImage,
	size: { readonly width: number; readonly height: number },
	maxBytes: number,
	jpegFirst: boolean,
): { readonly data: string; readonly mimeType: string } | undefined {
	const same = size.width === image.get_width() && size.height === image.get_height();
	const scaled = same ? image : resize(image, size.width, size.height, SamplingFilter.Lanczos3);
	try {
		const png = { mimeType: "image/png", encode: () => scaled.get_bytes() };
		const jpegs = JPEG_QUALITIES.map((quality) => ({
			mimeType: "image/jpeg",
			encode: () => scaled.get_bytes_jpeg(quality),
		}));
		for (const candidate of jpegFirst ? [...jpegs, png] : [png, ...jpegs]) {
			const bytes = candidate.encode();
			if (base64Length(bytes.byteLength) <= maxBytes) return { data: toBase64(bytes), mimeType: candidate.mimeType };
		}
		return undefined;
	} finally {
		if (!same) scaled.free();
	}
}

/**
 * 把 `image` 的 RGBA 像素按 EXIF 方向 5 到 8（即交换宽高的那几个方向）摆正。Photon 自带的 `rotate` 在直角
 * 旋转时会丢像素，因此这里自行移动像素。
 */
function transposed(
	image: PhotonImage,
	orientation: number,
): { readonly pixels: Uint8Array; readonly width: number; readonly height: number } {
	const width = image.get_width();
	const height = image.get_height();
	const source = image.get_raw_pixels();
	const pixels = new Uint8Array(source.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// (x, y) 落在摆正后图像中的位置，摆正后的图像宽度为 `height`。
			const outX = orientation === 5 || orientation === 8 ? y : height - 1 - y;
			const outY = orientation === 5 || orientation === 6 ? x : width - 1 - x;
			pixels.set(source.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (outY * height + outX) * 4);
		}
	}
	return { pixels, width: height, height: width };
}
