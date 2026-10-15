import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	getPngDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
} from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

/**
 * 将 Base64 图片数据转换为 Base64 PNG 数据；无法转换时返回 null。
 * 此函数在渲染期间同步调用。
 */
export type ImageTranscoder = (base64Data: string, mimeType: string) => string | null;

let imageTranscoder: ImageTranscoder | undefined;
// 为会重复创建 Image 实例的调用方提供后备缓存。以源数据为键，并按最近最少使用顺序淘汰。
const pngCache = new Map<string, string | null>();

/**
 * 注册 Kitty 协议终端上非 PNG 图片使用的转换器；该协议仅接受 PNG。
 * 未注册转换器时，此类图片会以文本形式降级显示。
 */
export function setImageTranscoder(transcoder: ImageTranscoder | undefined): void {
	imageTranscoder = transcoder;
	pngCache.clear();
}

function toPng(base64Data: string, mimeType: string): string | null {
	if (!imageTranscoder) return null;
	const cached = pngCache.get(base64Data);
	const png = cached === undefined ? imageTranscoder(base64Data, mimeType) : cached;
	pngCache.delete(base64Data);
	pngCache.set(base64Data, png);
	if (pngCache.size > 32) pngCache.delete(pngCache.keys().next().value!);
	return png;
}

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Kitty 图片 ID。若提供，则复用此 ID（用于动画或更新）。 */
	imageId?: number;
}

export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId?: number;
	/** 为 Kitty 转换后的 PNG 数据。失败结果不会缓存，以便后续转换器重试。 */
	private pngData?: string;

	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;
	}

	/** 获取此图片使用的 Kitty 图片 ID（如果有）。 */
	getImageId(): number | undefined {
		return this.imageId;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60));
		const cellDimensions = getCellDimensions();
		const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cellDimensions.widthPx) / cellDimensions.heightPx));
		const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight;

		const caps = getCapabilities();
		let data: string | null = this.base64Data;
		let dimensions = this.dimensions;
		if (caps.images === "kitty" && this.mimeType !== "image/png") {
			this.pngData ??= toPng(this.base64Data, this.mimeType) ?? undefined;
			data = this.pngData ?? null;
			// 转换过程可能会应用 EXIF 旋转，因此优先使用 PNG 自身的尺寸。
			if (data) dimensions = getPngDimensions(data) ?? dimensions;
		}
		let lines: string[];

		if (caps.images && data) {
			if (caps.images === "kitty" && this.imageId === undefined) {
				this.imageId = allocateImageId();
			}
			const result = renderImage(data, dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: maxHeight,
				imageId: this.imageId,
				moveCursor: false,
			});

			if (result) {
				// 保存图片 ID，以便稍后清理。
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				if (caps.images === "kitty") {
					// Kitty 中 C=1 表示不移动光标；此处不需要移动光标。
					lines = [result.sequence];

					// 返回 `rows` 行，使 TUI 能正确计算图片高度。
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
				} else {
					// 返回 `rows` 行，使 TUI 能正确计算图片高度。
					// 前 `rows-1` 行为空，并会在绘制图片前清除。
					// 最后一行先将光标上移并绘制图片，再将光标移回，
					// 使 TUI 的光标计数保持在滚动区域内。
					lines = [];
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
					const rowOffset = result.rows - 1;
					const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
					lines.push(moveUp + result.sequence);
				}
			} else {
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
			}
		} else {
			const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
			lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
		}

		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}
}
