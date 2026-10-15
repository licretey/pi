/**
 * 测试剪贴板图像处理中 BMP 到 PNG 的转换。
 * 由于模拟需求不同，本测试与 clipboard-image.test.ts 分开。
 *
 * 此测试验证 WSL2/WSLg 的修复：剪贴板经常提供 image/bmp，
 * 而不是 image/png。
 */
import { describe, expect, test, vi } from "vitest";
import { readClipboardImage } from "../src/utils/clipboard-image.ts";

function createTinyBmp1x1Red24bpp(): Uint8Array {
	// 最小的 1x1 24 位 BMP（BGR 格式，每行填充至 4 字节）。
	// 文件大小 = 14（BMP 标头）+ 40（DIB 标头）+ 4（像素行）= 58 字节。
	const buffer = Buffer.alloc(58);

	// BITMAPFILEHEADER
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2); // file size
	buffer.writeUInt16LE(0, 6); // reserved1
	buffer.writeUInt16LE(0, 8); // reserved2
	buffer.writeUInt32LE(54, 10); // pixel data offset

	// BITMAPINFOHEADER
	buffer.writeUInt32LE(40, 14); // DIB header size
	buffer.writeInt32LE(1, 18); // width
	buffer.writeInt32LE(1, 22); // height (positive = bottom-up)
	buffer.writeUInt16LE(1, 26); // planes
	buffer.writeUInt16LE(24, 28); // bits per pixel
	buffer.writeUInt32LE(0, 30); // compression (BI_RGB)
	buffer.writeUInt32LE(4, 34); // image size (incl. padding)
	buffer.writeInt32LE(0, 38); // x pixels per meter
	buffer.writeInt32LE(0, 42); // y pixels per meter
	buffer.writeUInt32LE(0, 46); // colors used
	buffer.writeUInt32LE(0, 50); // important colors

	// 像素数据（B、G、R）及 1 个字节的填充。
	buffer[54] = 0x00; // B
	buffer[55] = 0x00; // G
	buffer[56] = 0xff; // R
	buffer[57] = 0x00; // 填充字节。

	return new Uint8Array(buffer);
}

// 模拟 wl-paste 返回 BMP 图像。
vi.mock("../src/utils/clipboard-command.ts", () => ({
	runClipboardCommand: vi.fn(async (command: string, args: string[]) => {
		if (command === "wl-paste" && args.includes("--list-types")) return Buffer.from("image/bmp\n");
		if (command === "wl-paste" && args.includes("image/bmp")) return Buffer.from(createTinyBmp1x1Red24bpp());
		return undefined;
	}),
}));

vi.mock("@earendil-works/pi-tui", () => ({
	getNativeClipboard: () => ({ getImage: async () => createTinyBmp1x1Red24bpp() }),
}));

describe("readClipboardImage BMP conversion", () => {
	test.each(["linux", "win32"] as const)("%s: converts command/native BMP to PNG", async (platform) => {
		const image = await readClipboardImage({ env: { WAYLAND_DISPLAY: "wayland-0" }, platform });

		expect(image).not.toBeNull();
		expect(image!.mimeType).toBe("image/png");
		expect(Array.from(image!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});
});
