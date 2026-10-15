// JPEG 与 WebP 文件的 EXIF 方向，直接从字节读取，不解码图像。

/** JPEG 或 WebP 的 EXIF 方向，取值 1 到 8；缺失或不可读时为 1。 */
export function exifOrientation(bytes: Uint8Array): number {
	const tiff = tiffStart(bytes);
	if (tiff < 0 || tiff + 8 > bytes.length) return 1;
	const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
	const u16 = (at: number): number =>
		little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!;
	const u32 = (at: number): number =>
		little
			? (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
			: ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
	const directory = tiff + u32(tiff + 4);
	if (directory + 2 > bytes.length) return 1;
	const entries = u16(directory);
	for (let index = 0; index < entries; index++) {
		const entry = directory + 2 + index * 12;
		if (entry + 12 > bytes.length) return 1;
		// 标签 0x0112 是 Orientation（方向），是一个 SHORT，其值就存放在该条目内。
		if (u16(entry) === 0x0112) {
			const value = u16(entry + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}
	return 1;
}

/** JPEG 的 APP1 或 WebP 的 EXIF 块中 TIFF 头的起始位置；没有时为 -1。 */
function tiffStart(bytes: Uint8Array): number {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		for (let offset = 2; offset + 4 <= bytes.length; ) {
			if (bytes[offset] !== 0xff) return -1;
			const marker = bytes[offset + 1]!;
			if (marker === 0xff) {
				offset++;
				continue;
			}
			if (marker === 0xe1 && isExifHeader(bytes, offset + 4)) return offset + 10;
			offset += 2 + ((bytes[offset + 2]! << 8) | bytes[offset + 3]!);
		}
		return -1;
	}
	if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
		for (let offset = 12; offset + 8 <= bytes.length; ) {
			const size =
				(bytes[offset + 4]! |
					(bytes[offset + 5]! << 8) |
					(bytes[offset + 6]! << 16) |
					(bytes[offset + 7]! << 24)) >>>
				0;
			// 某些 WebP 文件在 TIFF 头前面加了 "Exif\0\0" 前缀。
			if (ascii(bytes, offset, "EXIF")) return isExifHeader(bytes, offset + 8) ? offset + 14 : offset + 8;
			// RIFF 块按偶数大小填充对齐。
			offset += 8 + size + (size % 2);
		}
	}
	return -1;
}

function isExifHeader(bytes: Uint8Array, offset: number): boolean {
	return ascii(bytes, offset, "Exif") && bytes[offset + 4] === 0 && bytes[offset + 5] === 0;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		if (bytes[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
