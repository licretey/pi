import { getNativeClipboard } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runClipboardCommand } from "./clipboard-command.ts";
import { detectSupportedImageMimeType } from "./mime.ts";
import { loadPhoton } from "./photon.ts";
import { isWSL } from "./wsl.ts";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * 使用 Photon 将不支持的图像格式转换为 PNG。
 * 转换功能不可用或转换失败时返回 null。
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

// undefined 表示后端执行失败；null 表示剪贴板中没有图像。Wayland 剪贴板为空时，
// 不应回退读取过期的 X11 剪贴板内容。
async function readClipboardImageViaWlPaste(): Promise<ClipboardImage | null | undefined> {
	const list = await runClipboardCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (list === undefined) return undefined;

	const types = list
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	const data = await runClipboardCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;

	return { bytes: data, mimeType: baseMimeType(selectedType) };
}

/**
 * 在 WSL 中，Linux 剪贴板（Wayland/X11）无法从 Windows 截图（Win+Shift+S）
 * 接收图像数据。PowerShell 可以读取 Windows 剪贴板，
 * 直接读取，因此将其用作回退方案。
 */
async function readClipboardImageViaPowerShell(): Promise<ClipboardImage | null> {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.png`);

	try {
		const winPathResult = await runClipboardCommand("wslpath", ["-w", tmpFile], {
			timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
		});
		if (winPathResult === undefined) {
			return null;
		}

		const winPath = winPathResult.toString("utf-8").trim();
		if (!winPath) {
			return null;
		}

		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = await runClipboardCommand("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (result === undefined) {
			return null;
		}

		const output = result.toString("utf-8").trim();
		if (output !== "ok") {
			return null;
		}

		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// 忽略清理错误。
		}
	}
}

async function readClipboardImageViaXclip(): Promise<ClipboardImage | null | undefined> {
	const targets = await runClipboardCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	if (targets === undefined) return undefined;

	const candidateTypes = targets
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);
	const preferred = selectPreferredImageMimeType(candidateTypes);
	if (!preferred) return null;

	const data = await runClipboardCommand("xclip", ["-selection", "clipboard", "-t", preferred, "-o"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;
	return { bytes: data, mimeType: baseMimeType(preferred) };
}

async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null | undefined> {
	const bytes = await getNativeClipboard()?.getImage();
	if (bytes === undefined) return undefined;
	if (!bytes?.length) return null;
	return { bytes, mimeType: detectSupportedImageMimeType(bytes) ?? "application/octet-stream" };
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null | undefined;

	if (platform === "linux") {
		const wsl = isWSL(env);
		if (isWaylandSession(env) || wsl) {
			image = await readClipboardImageViaWlPaste();
		}
		if (image === undefined) image = await readClipboardImageViaXclip();
		// Windows 剪贴板没有图像时，保留 Linux 对“空剪贴板”和“读取失败”的区分。
		if (!image && wsl) image = (await readClipboardImageViaPowerShell()) ?? image;
		if (image === undefined) image = await readClipboardImageViaNativeClipboard();
	} else {
		image = await readClipboardImageViaNativeClipboard();
	}

	if (!image) {
		return null;
	}

	// 将不支持的格式（例如封装为 BMP 的 Windows DIB 数据）转换为 PNG。
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}
