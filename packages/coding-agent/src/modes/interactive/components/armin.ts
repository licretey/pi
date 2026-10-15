/**
 * Armin 向你问好！这是一个使用 XBM 图像制作的趣味动画彩蛋。
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// XBM 图像：31×36 像素，低位在前，1 表示背景，0 表示前景。
export const ARMIN_WIDTH = 31;
export const ARMIN_HEIGHT = 36;
const WIDTH = ARMIN_WIDTH;
const HEIGHT = ARMIN_HEIGHT;
const BITS = [
	0xff, 0xff, 0xff, 0x7f, 0xff, 0xf0, 0xff, 0x7f, 0xff, 0xed, 0xff, 0x7f, 0xff, 0xdb, 0xff, 0x7f, 0xff, 0xb7, 0xff,
	0x7f, 0xff, 0x77, 0xfe, 0x7f, 0x3f, 0xf8, 0xfe, 0x7f, 0xdf, 0xff, 0xfe, 0x7f, 0xdf, 0x3f, 0xfc, 0x7f, 0x9f, 0xc3,
	0xfb, 0x7f, 0x6f, 0xfc, 0xf4, 0x7f, 0xf7, 0x0f, 0xf7, 0x7f, 0xf7, 0xff, 0xf7, 0x7f, 0xf7, 0xff, 0xe3, 0x7f, 0xf7,
	0x07, 0xe8, 0x7f, 0xef, 0xf8, 0x67, 0x70, 0x0f, 0xff, 0xbb, 0x6f, 0xf1, 0x00, 0xd0, 0x5b, 0xfd, 0x3f, 0xec, 0x53,
	0xc1, 0xff, 0xef, 0x57, 0x9f, 0xfd, 0xee, 0x5f, 0x9f, 0xfc, 0xae, 0x5f, 0x1f, 0x78, 0xac, 0x5f, 0x3f, 0x00, 0x50,
	0x6c, 0x7f, 0x00, 0xdc, 0x77, 0xff, 0xc0, 0x3f, 0x78, 0xff, 0x01, 0xf8, 0x7f, 0xff, 0x03, 0x9c, 0x78, 0xff, 0x07,
	0x8c, 0x7c, 0xff, 0x0f, 0xce, 0x78, 0xff, 0xff, 0xcf, 0x7f, 0xff, 0xff, 0xcf, 0x78, 0xff, 0xff, 0xdf, 0x78, 0xff,
	0xff, 0xdf, 0x7d, 0xff, 0xff, 0x3f, 0x7e, 0xff, 0xff, 0xff, 0x7f,
];

const BYTES_PER_ROW = Math.ceil(WIDTH / 8);
const DISPLAY_HEIGHT = Math.ceil(HEIGHT / 2); // 使用半块字符渲染。

type Effect = "typewriter" | "scanline" | "rain" | "fade" | "crt" | "glitch" | "dissolve";

const EFFECTS: Effect[] = ["typewriter", "scanline", "rain", "fade", "crt", "glitch", "dissolve"];

// 获取 (x, y) 处的像素：true 表示前景，false 表示背景。
export function isArminPixel(x: number, y: number): boolean {
	if (y >= HEIGHT) return false;
	const byteIndex = y * BYTES_PER_ROW + Math.floor(x / 8);
	const bitIndex = x % 8;
	return ((BITS[byteIndex] >> bitIndex) & 1) === 0;
}

// 获取单元格对应的字符；每个字符合并表示垂直方向上的 2 个像素。
function getChar(x: number, row: number): string {
	const upper = isArminPixel(x, row * 2);
	const lower = isArminPixel(x, row * 2 + 1);
	if (upper && lower) return "█";
	if (upper) return "▀";
	if (lower) return "▄";
	return " ";
}

// 构建最终图像网格。
function buildFinalGrid(): string[][] {
	const grid: string[][] = [];
	for (let row = 0; row < DISPLAY_HEIGHT; row++) {
		const line: string[] = [];
		for (let x = 0; x < WIDTH; x++) {
			line.push(getChar(x, row));
		}
		grid.push(line);
	}
	return grid;
}

export class ArminComponent implements Component {
	private ui: TUI;
	private interval: ReturnType<typeof setInterval> | null = null;
	private effect: Effect;
	private finalGrid: string[][];
	private currentGrid: string[][];
	private effectState: Record<string, unknown> = {};
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private gridVersion = 0;
	private cachedVersion = -1;

	constructor(ui: TUI) {
		this.ui = ui;
		this.effect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
		this.finalGrid = buildFinalGrid();
		this.currentGrid = this.createEmptyGrid();

		this.initEffect();
		this.startAnimation();
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.gridVersion) {
			return this.cachedLines;
		}

		const padding = 1;
		const availableWidth = width - padding;

		this.cachedLines = this.currentGrid.map((row) => {
			// 先将行裁剪到可用宽度，再应用颜色。
			const clipped = row.slice(0, availableWidth).join("");
			const padRight = Math.max(0, width - padding - clipped.length);
			return ` ${theme.fg("accent", clipped)}${" ".repeat(padRight)}`;
		});

		// 在末尾添加 "ARMIN SAYS HI"。
		const message = "ARMIN SAYS HI";
		const msgPadRight = Math.max(0, width - padding - message.length);
		this.cachedLines.push(` ${theme.fg("accent", message)}${" ".repeat(msgPadRight)}`);

		this.cachedWidth = width;
		this.cachedVersion = this.gridVersion;

		return this.cachedLines;
	}

	private createEmptyGrid(): string[][] {
		return Array.from({ length: DISPLAY_HEIGHT }, () => Array(WIDTH).fill(" "));
	}

	private initEffect(): void {
		switch (this.effect) {
			case "typewriter":
				this.effectState = { pos: 0 };
				break;
			case "scanline":
				this.effectState = { row: 0 };
				break;
			case "rain":
				// 记录每一列中落下像素的位置。
				this.effectState = {
					drops: Array.from({ length: WIDTH }, () => ({
						y: -Math.floor(Math.random() * DISPLAY_HEIGHT * 2),
						settled: 0,
					})),
				};
				break;
			case "fade": {
				// 打乱所有像素的位置。
				const positions: [number, number][] = [];
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					for (let x = 0; x < WIDTH; x++) {
						positions.push([row, x]);
					}
				}
				// 使用 Fisher–Yates 算法打乱顺序。
				for (let i = positions.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[positions[i], positions[j]] = [positions[j], positions[i]];
				}
				this.effectState = { positions, idx: 0 };
				break;
			}
			case "crt":
				this.effectState = { expansion: 0 };
				break;
			case "glitch":
				this.effectState = { phase: 0, glitchFrames: 8 };
				break;
			case "dissolve": {
				// 先用随机噪点填充画面。
				this.currentGrid = Array.from({ length: DISPLAY_HEIGHT }, () =>
					Array.from({ length: WIDTH }, () => {
						const chars = [" ", "░", "▒", "▓", "█", "▀", "▄"];
						return chars[Math.floor(Math.random() * chars.length)];
					}),
				);
				// 打乱位置顺序，让图像逐渐显现。
				const dissolvePositions: [number, number][] = [];
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					for (let x = 0; x < WIDTH; x++) {
						dissolvePositions.push([row, x]);
					}
				}
				for (let i = dissolvePositions.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[dissolvePositions[i], dissolvePositions[j]] = [dissolvePositions[j], dissolvePositions[i]];
				}
				this.effectState = { positions: dissolvePositions, idx: 0 };
				break;
			}
		}
	}

	private startAnimation(): void {
		const fps = this.effect === "glitch" ? 60 : 30;
		this.interval = setInterval(() => {
			const done = this.tickEffect();
			this.updateDisplay();
			this.ui.requestRender();
			if (done) {
				this.stopAnimation();
			}
		}, 1000 / fps);
	}

	private stopAnimation(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	private tickEffect(): boolean {
		switch (this.effect) {
			case "typewriter":
				return this.tickTypewriter();
			case "scanline":
				return this.tickScanline();
			case "rain":
				return this.tickRain();
			case "fade":
				return this.tickFade();
			case "crt":
				return this.tickCrt();
			case "glitch":
				return this.tickGlitch();
			case "dissolve":
				return this.tickDissolve();
			default:
				return true;
		}
	}

	private tickTypewriter(): boolean {
		const state = this.effectState as { pos: number };
		const pixelsPerFrame = 3;

		for (let i = 0; i < pixelsPerFrame; i++) {
			const row = Math.floor(state.pos / WIDTH);
			const x = state.pos % WIDTH;
			if (row >= DISPLAY_HEIGHT) return true;
			this.currentGrid[row][x] = this.finalGrid[row][x];
			state.pos++;
		}
		return false;
	}

	private tickScanline(): boolean {
		const state = this.effectState as { row: number };
		if (state.row >= DISPLAY_HEIGHT) return true;

		// 复制整行。
		for (let x = 0; x < WIDTH; x++) {
			this.currentGrid[state.row][x] = this.finalGrid[state.row][x];
		}
		state.row++;
		return false;
	}

	private tickRain(): boolean {
		const state = this.effectState as {
			drops: { y: number; settled: number }[];
		};

		let allSettled = true;
		this.currentGrid = this.createEmptyGrid();

		for (let x = 0; x < WIDTH; x++) {
			const drop = state.drops[x];

			// 绘制已落定的像素。
			for (let row = DISPLAY_HEIGHT - 1; row >= DISPLAY_HEIGHT - drop.settled; row--) {
				if (row >= 0) {
					this.currentGrid[row][x] = this.finalGrid[row][x];
				}
			}

			// 检查当前列是否已完成。
			if (drop.settled >= DISPLAY_HEIGHT) continue;

			allSettled = false;

			// 查找当前列的目标行，即最靠下的非空格像素。
			let targetRow = -1;
			for (let row = DISPLAY_HEIGHT - 1 - drop.settled; row >= 0; row--) {
				if (this.finalGrid[row][x] !== " ") {
					targetRow = row;
					break;
				}
			}

			// 让落下的像素向下移动。
			drop.y++;

			// 绘制正在下落的像素。
			if (drop.y >= 0 && drop.y < DISPLAY_HEIGHT) {
				if (targetRow >= 0 && drop.y >= targetRow) {
					// 像素落定。
					drop.settled = DISPLAY_HEIGHT - targetRow;
					drop.y = -Math.floor(Math.random() * 5) - 1;
				} else {
					// 像素仍在下落。
					this.currentGrid[drop.y][x] = "▓";
				}
			}
		}

		return allSettled;
	}

	private tickFade(): boolean {
		const state = this.effectState as { positions: [number, number][]; idx: number };
		const pixelsPerFrame = 15;

		for (let i = 0; i < pixelsPerFrame; i++) {
			if (state.idx >= state.positions.length) return true;
			const [row, x] = state.positions[state.idx];
			this.currentGrid[row][x] = this.finalGrid[row][x];
			state.idx++;
		}
		return false;
	}

	private tickCrt(): boolean {
		const state = this.effectState as { expansion: number };
		const midRow = Math.floor(DISPLAY_HEIGHT / 2);

		this.currentGrid = this.createEmptyGrid();

		// 从中间开始向上下两侧扩展绘制。
		const top = midRow - state.expansion;
		const bottom = midRow + state.expansion;

		for (let row = Math.max(0, top); row <= Math.min(DISPLAY_HEIGHT - 1, bottom); row++) {
			for (let x = 0; x < WIDTH; x++) {
				this.currentGrid[row][x] = this.finalGrid[row][x];
			}
		}

		state.expansion++;
		return state.expansion > DISPLAY_HEIGHT;
	}

	private tickGlitch(): boolean {
		const state = this.effectState as { phase: number; glitchFrames: number };

		if (state.phase < state.glitchFrames) {
			// 故障阶段：显示受干扰的图像。
			this.currentGrid = this.finalGrid.map((row) => {
				const offset = Math.floor(Math.random() * 7) - 3;
				const glitchRow = [...row];

				// 随机水平偏移。
				if (Math.random() < 0.3) {
					const shifted = glitchRow.slice(offset).concat(glitchRow.slice(0, offset));
					return shifted.slice(0, WIDTH);
				}

				// 随机交换垂直位置。
				if (Math.random() < 0.2) {
					const swapRow = Math.floor(Math.random() * DISPLAY_HEIGHT);
					return [...this.finalGrid[swapRow]];
				}

				return glitchRow;
			});
			state.phase++;
			return false;
		}

		// 最后一帧：显示未失真的图像。
		this.currentGrid = this.finalGrid.map((row) => [...row]);
		return true;
	}

	private tickDissolve(): boolean {
		const state = this.effectState as { positions: [number, number][]; idx: number };
		const pixelsPerFrame = 20;

		for (let i = 0; i < pixelsPerFrame; i++) {
			if (state.idx >= state.positions.length) return true;
			const [row, x] = state.positions[state.idx];
			this.currentGrid[row][x] = this.finalGrid[row][x];
			state.idx++;
		}
		return false;
	}

	private updateDisplay(): void {
		this.gridVersion++;
	}

	dispose(): void {
		this.stopAnimation();
	}
}
