import { getCapabilities, type ImageTranscoder, setImageTranscoder } from "@earendil-works/pi-tui";
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

function encodePng(photon: Photon, bytes: Uint8Array): Uint8Array | null {
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		// 转换失败。
		return null;
	}
}

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		// Photon 不可用，无法转换。
		return null;
	}
	return encodePng(photon, bytes);
}

/**
 * 将图像转换为 PNG 格式，以便在终端中显示。
 * Kitty 图形协议要求使用 PNG 格式（f=100）。
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// 已经是 PNG，无需转换。
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}

/**
 * 加载 photon，并为 pi-tui 的 Kitty 图像渲染返回一个同步 PNG 转码器。
 * 如果无法加载 photon，则返回 undefined。
 */
export async function loadPngTranscoder(): Promise<ImageTranscoder | undefined> {
	const photon = await loadPhoton();
	if (!photon) return undefined;
	return (base64Data) => {
		const pngBytes = encodePng(photon, new Uint8Array(Buffer.from(base64Data, "base64")));
		return pngBytes ? Buffer.from(pngBytes).toString("base64") : null;
	};
}

let pngTranscoderLoad: Promise<boolean> | undefined;
let pngTranscoderRegistered = false;

/**
 * 在支持 Kitty 协议的终端中，将 photon 注册为 pi-tui 的图像转码器，以便渲染非 PNG 图像。
 * photon 只会加载一次。注册完成后调用 `onRegistered`，让调用方重新渲染此前显示为文本回退的图像；
 * 若转码器已注册或 photon 无法加载，则不会调用该回调。
 */
export function ensurePngTranscoder(onRegistered: () => void): void {
	if (pngTranscoderRegistered || getCapabilities().images !== "kitty") return;
	pngTranscoderLoad ??= loadPngTranscoder().then((transcoder) => {
		if (!transcoder) return false;
		setImageTranscoder(transcoder);
		pngTranscoderRegistered = true;
		return true;
	});
	void pngTranscoderLoad.then((registered) => {
		if (registered) onRegistered();
	});
}
