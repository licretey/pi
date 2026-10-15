import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { TerminalColorMode } from "./colors.ts";

export type ImageProtocol = "kitty" | "iterm2" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/** Kitty 图片 ID。若提供，则复用或替换此 ID 对应的图片。 */
	imageId?: number;
	/** Kitty 放置图片后是否执行默认的光标移动。 */
	moveCursor?: boolean;
}

let cachedCapabilities: TerminalCapabilities | null = null;
let capabilityOverrides: Partial<TerminalCapabilities> = {};

// 默认单元格尺寸；终端响应查询后由 TUI 更新。
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

/**
 * 检查连接的 tmux 客户端是否会将 OSC 8 超链接转发到外层终端。
 * 只有 tmux 的 `client_termfeatures` 包含 `hyperlinks` 时才会重新发送；否则会移除超链接。
 * 遇到任何错误时均回退为 `false`。
 */
function probeTmuxHyperlinks(): boolean {
	try {
		const termfeatures = execSync("tmux display-message -p '#{client_termfeatures}'", {
			encoding: "utf8",
			timeout: 250,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return termfeatures
			.split(",")
			.map((feature) => feature.trim())
			.includes("hyperlinks");
	} catch {
		return false;
	}
}

function detectCapabilitiesFromEnvironment(tmuxForwardsHyperlink: () => boolean): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit" || term.endsWith("-direct");
	const isWindowsConsole = process.platform === "win32";

	// 仅在 tmux 确认会转发时输出 OSC 8 超链接。
	// 图片协议在 tmux 中不可靠，因此将 `images` 设为 null。
	if (process.env.TMUX || term.startsWith("tmux")) {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: tmuxForwardsHyperlink() };
	}

	// screen 不会转发 OSC 8 超链接，因此在其中禁用超链接。
	if (term.startsWith("screen")) {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
	}

	// Herdr 会转发 OSC 8 超链接。它运行在另一个终端内，该终端的环境变量（如 KITTY_WINDOW_ID）可能泄漏到其窗格中，
	// 因此要先检查 Herdr，并禁用图片协议。
	if (termProgram === "herdr") {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: true };
	}

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Warp 支持 Kitty 图形协议和 OSC 8 超链接。
	if (termProgram === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	if (process.env.WT_SESSION) {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (termProgram === "alacritty" || termProgram === "vscode" || termProgram === "zed") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (terminalEmulator === "jetbrains-jediterm") {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Windows Terminal 并非总会设置 WT_SESSION，例如直接通过 Win+R 启动 cmd.exe 时。
	// 新版 Windows 控制台支持真彩色；除非已在上文明确检测到超链接支持，否则保持禁用。
	if (isWindowsConsole) {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// 对未知终端采取保守策略。会吞掉 OSC 8 的终端会将其不可见地当作“纯文本”处理，
	// 导致 URL 从渲染结果中消失。除非上文已明确识别出支持超链接的终端，否则使用旧式 `文本 (url)` 格式。
	return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
}

function parseBooleanCapabilityOverride(value: string | undefined): boolean | undefined {
	return value === "1" ? true : value === "0" ? false : undefined;
}

export function detectCapabilities(tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks): TerminalCapabilities {
	const hyperlinks = parseBooleanCapabilityOverride(process.env.PI_HYPERLINKS);
	const detected = detectCapabilitiesFromEnvironment(
		hyperlinks === undefined ? tmuxForwardsHyperlink : () => hyperlinks,
	);
	const imageProtocol = process.env.PI_IMAGE_PROTOCOL?.toLowerCase();
	const images =
		imageProtocol === "kitty" || imageProtocol === "iterm2"
			? imageProtocol
			: imageProtocol === "none" || imageProtocol === "0"
				? null
				: undefined;
	const trueColor = parseBooleanCapabilityOverride(process.env.PI_TRUE_COLOR);
	return {
		...detected,
		...(images !== undefined ? { images } : {}),
		...(trueColor !== undefined ? { trueColor } : {}),
		...(hyperlinks !== undefined ? { hyperlinks } : {}),
	};
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		const hyperlinks = capabilityOverrides.hyperlinks;
		cachedCapabilities = {
			...detectCapabilities(hyperlinks === undefined ? undefined : () => hyperlinks),
			...capabilityOverrides,
		};
	}
	return cachedCapabilities;
}

export function getTerminalColorMode(capabilities: TerminalCapabilities = getCapabilities()): TerminalColorMode {
	return capabilities.trueColor ? "truecolor" : "256color";
}

export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
}

/** 覆盖指定的自动检测能力。 */
export function setCapabilityOverrides(overrides: Partial<TerminalCapabilities>): void {
	if (
		capabilityOverrides.images === overrides.images &&
		capabilityOverrides.trueColor === overrides.trueColor &&
		capabilityOverrides.hyperlinks === overrides.hyperlinks
	) {
		return;
	}
	capabilityOverrides = { ...overrides };
	cachedCapabilities = null;
}

/** 覆盖缓存的能力信息。可用于测试两种代码路径。 */
export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";

export function isImageLine(line: string): boolean {
	// 快速路径：序列位于行首（单行图片）。
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		return true;
	}
	// 慢速路径：序列位于其他位置（多行图片前带有光标上移序列）。
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

/**
 * 为 Kitty 图形协议生成随机图片 ID。
 * 使用随机 ID，避免不同模块实例之间发生冲突。
 * 例如主应用与扩展之间。
 */
export function allocateImageId(): number {
	// 使用 [1, 0xffffffff] 范围内的随机 ID，以避免冲突。
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
		/** Kitty 放置图片后是否执行默认的光标移动。默认值：true。 */
		moveCursor?: boolean;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.moveCursor === false) params.push("C=1");
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * 根据 ID 删除 Kitty 图形图片。
 * 使用大写字母 'I' 同时释放图片数据。
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/**
 * 删除所有可见的 Kitty 图形图片。
 * 使用大写字母 'A' 同时释放图片数据。
 */
export function deleteAllKittyImages(): string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}

/** 删除所有可见的 Kitty 图片放置位置，同时保留已上传的图片数据。 */
export function deleteAllKittyPlacements(): string {
	return "\x1b_Ga=d,d=a,q=2\x1b\\";
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [
		`inline=${options.inline !== false ? 1 : 0}`,
		`size=${Buffer.byteLength(base64Data, "base64")}`,
	];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

export interface ImageCellSize {
	columns: number;
	rows: number;
}

export interface KittyImageMetadata extends ImageCellSize {
	imageId: number;
	widthPx: number;
	heightPx: number;
}

interface RegisteredKittyImageMetadata extends KittyImageMetadata {
	transmissionGeneration: number;
}

export interface KittyImagePlacement {
	imageId: number;
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
	rows: number;
	sequence: string;
	replacementLine: string;
}

const kittyImageMetadata = new Map<number, RegisteredKittyImageMetadata>();
let kittyTransmissionGeneration = 0;

export function registerKittyImageMetadata(metadata: KittyImageMetadata): void {
	kittyTransmissionGeneration += 1;
	kittyImageMetadata.delete(metadata.imageId);
	kittyImageMetadata.set(metadata.imageId, { ...metadata, transmissionGeneration: kittyTransmissionGeneration });
	if (kittyImageMetadata.size > 1000) {
		const oldestImageId = kittyImageMetadata.keys().next().value;
		if (oldestImageId !== undefined) kittyImageMetadata.delete(oldestImageId);
	}
}

function getRegisteredKittyImageMetadataFromControls(controls: string): RegisteredKittyImageMetadata | undefined {
	const imageId = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls)?.[1];
	return imageId === undefined ? undefined : kittyImageMetadata.get(Number.parseInt(imageId, 10));
}

function getRegisteredKittyImageMetadata(line: string): RegisteredKittyImageMetadata | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	return controls === undefined ? undefined : getRegisteredKittyImageMetadataFromControls(controls);
}

function getExplicitKittyImageRows(controls: string): number | undefined {
	const value = /(?:^|,)r=(\d+)(?:,|$)/.exec(controls)?.[1];
	if (value === undefined) return undefined;
	const rows = Number.parseInt(value, 10);
	return rows > 0 ? rows : undefined;
}

function getKittyImageRowsFromControls(controls: string, fallbackRows: number): number {
	return getExplicitKittyImageRows(controls) ?? fallbackRows;
}

export function getKittyImageMetadata(line: string): KittyImageMetadata | undefined {
	const metadata = getRegisteredKittyImageMetadata(line);
	if (!metadata) return undefined;
	return {
		imageId: metadata.imageId,
		columns: metadata.columns,
		rows: metadata.rows,
		widthPx: metadata.widthPx,
		heightPx: metadata.heightPx,
	};
}

const KITTY_PLACEMENT_CONTROL_KEYS = new Set([
	"i",
	"p",
	"x",
	"y",
	"w",
	"h",
	"X",
	"Y",
	"c",
	"r",
	"C",
	"U",
	"z",
	"P",
	"Q",
	"H",
	"V",
]);

/** 不扫描图片负载，直接读取图片放置位置占用的行数。 */
export function getKittyImagePlacementRows(line: string): number | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	if (controls === undefined) return undefined;
	const explicitRows = getExplicitKittyImageRows(controls);
	if (explicitRows !== undefined) return explicitRows;
	return getRegisteredKittyImageMetadataFromControls(controls)?.rows;
}

/** 为 {@link renderImage} 输出的图片行构建仅放置图片的命令。 */
export function getKittyImagePlacement(line: string): KittyImagePlacement | undefined {
	const match = /\x1b_G([^;]*);/.exec(line);
	if (!match) return undefined;
	const metadata = getRegisteredKittyImageMetadataFromControls(match[1]);
	if (!metadata) return undefined;

	let commandStart = match.index;
	let commandControls = match[1];
	let transmissionEnd: number;
	while (true) {
		const terminator = line.indexOf("\x1b\\", commandStart + KITTY_PREFIX.length);
		if (terminator === -1) return undefined;
		transmissionEnd = terminator + 2;
		if (!/(?:^|,)m=1(?:,|$)/.test(commandControls)) break;
		commandStart = transmissionEnd;
		if (!line.startsWith(KITTY_PREFIX, commandStart)) return undefined;
		const controlsEnd = line.indexOf(";", commandStart + KITTY_PREFIX.length);
		if (controlsEnd === -1) return undefined;
		commandControls = line.slice(commandStart + KITTY_PREFIX.length, controlsEnd);
	}

	const controls = match[1]
		.split(",")
		.filter((control) => KITTY_PLACEMENT_CONTROL_KEYS.has(control.split("=", 1)[0] ?? ""));
	const sequence = `\x1b_Ga=p,q=2,${controls.join(",")}\x1b\\`;
	return {
		imageId: metadata.imageId,
		transmissionGeneration: metadata.transmissionGeneration,
		transmissionBytes: transmissionEnd - match.index,
		estimatedDecodedBytes: metadata.widthPx * metadata.heightPx * 4,
		rows: getKittyImageRowsFromControls(match[1], metadata.rows),
		sequence,
		replacementLine: `${line.slice(0, match.index)}${sequence}${line.slice(transmissionEnd)}`,
	};
}

export function cropKittyImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	const metadata = getKittyImageMetadata(line);
	const match = /\x1b_G([^;]*);/.exec(line);
	if (!metadata || !match || hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0) return line;
	const croppedRows = Math.min(visibleRows, metadata.rows - hiddenRows);
	if (hiddenRows === 0 && croppedRows === metadata.rows) return line;
	const sourceY = Math.floor((metadata.heightPx * hiddenRows) / metadata.rows);
	const sourceEnd = Math.ceil((metadata.heightPx * (hiddenRows + croppedRows)) / metadata.rows);
	const sourceHeight = Math.max(1, Math.min(metadata.heightPx, sourceEnd) - sourceY);
	const controls = match[1].split(",").filter((control) => !/^[yhr]=/.test(control));
	controls.push(`y=${sourceY}`, `h=${sourceHeight}`, `r=${croppedRows}`);
	return `${line.slice(0, match.index)}\x1b_G${controls.join(",")};${line.slice(match.index + match[0].length)}`;
}

function chooseLessDistortedCellCount(upperCount: number, idealCount: number): number {
	if (upperCount <= 1) return upperCount;

	const lowerCount = upperCount - 1;
	const upperDistortion = Math.max(upperCount / idealCount, idealCount / upperCount);
	const lowerDistortion = Math.max(lowerCount / idealCount, idealCount / lowerCount);
	return lowerDistortion < upperDistortion ? lowerCount : upperCount;
}

export function calculateImageCellSize(
	imageDimensions: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells?: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
	optimizeAspectRatio = false,
): ImageCellSize {
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	const imageWidth = Math.max(1, imageDimensions.widthPx);
	const imageHeight = Math.max(1, imageDimensions.heightPx);

	const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
	const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cellDimensions.heightPx) / imageHeight;
	const scale = Math.min(widthScale, heightScale);

	const scaledWidthPx = imageWidth * scale;
	const scaledHeightPx = imageHeight * scale;
	let columns = Math.max(1, Math.min(maxWidth, Math.ceil(scaledWidthPx / cellDimensions.widthPx)));
	const heightRows = scaledHeightPx / cellDimensions.heightPx;
	let rows = Math.max(1, Math.ceil(heightRows));
	if (maxHeight !== undefined) {
		rows = Math.min(maxHeight, rows);
	}

	if (!optimizeAspectRatio) {
		return { columns, rows };
	}

	if (widthScale <= heightScale) {
		const idealRows = (columns * cellDimensions.widthPx * imageHeight) / (imageWidth * cellDimensions.heightPx);
		rows = chooseLessDistortedCellCount(rows, idealRows);
	} else {
		const idealColumns = (rows * cellDimensions.heightPx * imageWidth) / (imageHeight * cellDimensions.widthPx);
		columns = chooseLessDistortedCellCount(columns, idealColumns);
	}

	return { columns, rows };
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	return calculateImageCellSize(imageDimensions, targetWidthCells, undefined, cellDimensions).rows;
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; columns: number; rows: number; imageId?: number } | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	// 减少 Kitty 按单元格对齐导致的失真，同时不缩小 iTerm2 的预留区域。
	const size = calculateImageCellSize(
		imageDimensions,
		maxWidth,
		options.maxHeightCells,
		getCellDimensions(),
		caps.images === "kitty",
	);

	if (caps.images === "kitty") {
		if (options.imageId !== undefined) {
			registerKittyImageMetadata({
				imageId: options.imageId,
				columns: size.columns,
				rows: size.rows,
				widthPx: imageDimensions.widthPx,
				heightPx: imageDimensions.heightPx,
			});
		}
		const sequence = encodeKitty(base64Data, {
			columns: size.columns,
			rows: size.rows,
			imageId: options.imageId,
			moveCursor: options.moveCursor,
		});
		return { sequence, columns: size.columns, rows: size.rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: size.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, columns: size.columns, rows: size.rows };
	}

	return null;
}

/**
 * 使用 OSC 8 超链接序列包裹文本。
 * 在支持 OSC 8 的终端中，该文本会显示为可点击的超链接。
 * 例如 Ghostty、Kitty、WezTerm、iTerm2、VSCode 等。
 * 在不支持 OSC 8 的终端中，转义序列会被忽略，只显示纯文本。
 *
 * @param text 要显示的可见文本。
 * @param url 要链接到的 URL。
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** 将以主目录开头的绝对路径缩写为 ~/...，以便紧凑显示。 */
function shortenImagePath(filename: string): string {
	const home = homedir();
	if (home && (filename === home || filename.startsWith(`${home}/`) || filename.startsWith(`${home}\\`))) {
		return `~${filename.slice(home.length)}`;
	}
	return filename;
}

/**
 * 终端无法渲染行内图片时使用的文本回退格式。
 * 绝对路径会缩写显示（~/...）；如果支持 OSC 8 超链接，则链接到 file:// 路径，以便仍可打开完整路径。
 */
export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) {
		const display = shortenImagePath(filename);
		if (getCapabilities().hyperlinks && isAbsolute(filename)) {
			parts.push(hyperlink(display, pathToFileURL(filename).href));
		} else {
			parts.push(display);
		}
	}
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
