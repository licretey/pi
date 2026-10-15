import {
	backgroundAnsi,
	type Color,
	type Component,
	colorToRgb,
	foregroundAnsi,
	getKeybindings,
	indexedColor,
	rgbColor,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { ARMIN_HEIGHT, ARMIN_WIDTH, isArminPixel } from "./armin.ts";
import { formatKeyText } from "./keybinding-hints.ts";

/**
 * 全屏 3D 彩蛋：pi logo（点击头部 logo）和 Armin（/arminsayshi）。两者都是由每个像素一个方块
 * 构成的位图。当前屏幕化为盲文尘埃消散，同时模型在中央旋转，其方块玩滑动拼图。离开时按相同
 * 时间线倒放，屏幕随之复原。
 *
 * pi logo 从头部飞起、飞到中央并放大；尘埃从头部 logo 处扩散。
 * Armin 从中央的一点长出来；尘埃从中心扩散。
 *
 * 方块按盲文点做光线投射。一个盲文单元格容纳 2x4 个近似方形的点，因此半块位图的一个像素恰好是
 * 2x2 个点，头部 logo（4x2 个单元格）飞起时是 8x8 个点。
 */

type Rgb = readonly [number, number, number];

interface ScreenCell {
	text: string;
	/** 字素（grapheme）为 1 或 2，宽字素的第二列为 0。 */
	width: number;
	fg: Rgb;
	/** 单元格使用终端默认背景时为 undefined。 */
	bg: Rgb | undefined;
	/** 距该单元格化为盲文尘埃的秒数。 */
	delay: number;
	/** 该字形变为的盲文点数量。 */
	ink: number;
	seed: number;
}

interface Star {
	/** 星星所占据的单个盲文点组成的盲文字符。 */
	glyph: string;
	/** 星星偏向的颜色；它只会显示从背景色向该色的一小步过渡。 */
	tint: Rgb;
	/** 从背景色偏向 tint 的最大幅度，取值 0 到 1。 */
	strength: number;
	phase: number;
	/** 闪烁速度，单位为弧度每秒。 */
	speed: number;
}

interface Box {
	min: readonly [number, number, number];
	max: readonly [number, number, number];
	color: Rgb;
}

interface Pose {
	centerX: number;
	centerY: number;
	/** 深度 0 处每个模型像素对应的盲文点数。 */
	scale: number;
	yaw: number;
	pitch: number;
	roll: number;
}

const DEPTH = 0.7;
const FLY_START = 0.1;
const FLY_DURATION = 1.3;
/** 没有起点（origin）的模型出现时每个像素对应的盲文点数——模型从中央的一点长大。 */
const START_SCALE = 0.1;

/** 方块的网格位置：位图中的列与行，以及深度上的层（-1、0、1）。 */
type Cell3 = readonly [number, number, number];

/** 由每个前景色像素一个方块构成的位图。每个方块都是拼图可滑动的一块。 */
interface Model {
	/** 位图尺寸，单位为像素。 */
	columns: number;
	rows: number;
	blocks: Array<{ home: Cell3; color: Rgb }>;
	/** 相机距模型中心的距离，单位为像素。 */
	cameraDistance: number;
	/** 任一方块角落距中心的最远距离，含外层深度的方块。 */
	radius: number;
	/** 旋转模型最多可覆盖的屏幕宽度比例。 */
	widthShare: number;
	/** 拼图每步移动的方块数，给定一个 0 到 1 的随机数。 */
	puzzleMoves: (random: number) => number;
	/**
	 * 模型半块渲染在屏幕上的左上单元格。模型从这里飞起并取代它。
	 * 为 undefined 时从中心长出。
	 */
	origin: { column: number; row: number } | undefined;
}

function createModel(
	columns: number,
	rows: number,
	pixel: (column: number, row: number) => Rgb | undefined,
	options: Pick<Model, "cameraDistance" | "widthShare" | "origin"> & {
		puzzleMoves: (random: number, blockCount: number) => number;
	},
): Model {
	const blocks: Model["blocks"] = [];
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const color = pixel(column, row);
			if (color) blocks.push({ home: [column, row, 0], color });
		}
	}
	return {
		columns,
		rows,
		blocks,
		cameraDistance: options.cameraDistance,
		radius: Math.hypot(columns / 2, rows / 2, 1 + DEPTH / 2),
		widthShare: options.widthShare,
		puzzleMoves: (random) => options.puzzleMoves(random, blocks.length),
		origin: options.origin,
	};
}

const CORAL: Rgb = [228, 138, 122];
const BLUE: Rgb = [79, 142, 179];
const YELLOW: Rgb = [234, 182, 93];
const PI_LOGO_PIXELS = ["ccc.", "b.c.", "bb.y", "b..y"];
const PI_LOGO_COLORS: Record<string, Rgb> = { c: CORAL, b: BLUE, y: YELLOW };

function piLogoModel(origin: { column: number; row: number }): Model {
	return createModel(4, 4, (column, row) => PI_LOGO_COLORS[PI_LOGO_PIXELS[row]![column]!], {
		cameraDistance: 10,
		widthShare: 0.35,
		puzzleMoves: (random) => (random < 0.4 ? 2 : 1),
		origin,
	});
}

function arminModel(color: Rgb): Model {
	return createModel(ARMIN_WIDTH, ARMIN_HEIGHT, (column, row) => (isArminPixel(column, row) ? color : undefined), {
		// 距离足够远，使约 36 个方块高的图形仍保持平缓的透视。
		cameraDistance: 80,
		widthShare: 0.45,
		puzzleMoves: (random, blockCount) => Math.round(blockCount * (0.03 + random * 0.04)),
		origin: undefined,
	});
}

// 滑动拼图：模型旋转一段时间后，方块每次几块地滑入相邻的空闲单元格。
// 每个循环会打乱一次、让每个方块飞回原位，并短暂保持完整模型。
const PUZZLE_START = FLY_START + FLY_DURATION + 3;
const PUZZLE_STEP = 0.3;
const PUZZLE_STEPS = 12;
const PUZZLE_RETURN = 1;
const PUZZLE_HOLD = 0.6;
const PUZZLE_CYCLE = PUZZLE_STEP * PUZZLE_STEPS + PUZZLE_RETURN + PUZZLE_HOLD;
const PUZZLE_MOVES: Cell3[] = [
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[0, 0, 1],
	[0, 0, -1],
];

/** 一次打乱循环中每一步之后的方块位置，从原位开始。每个循环内确定。 */
function shuffleSteps(model: Model, cycle: number): Cell3[][] {
	const { columns, rows } = model;
	let positions: Cell3[] = model.blocks.map((block) => block.home);
	const steps = [positions];
	const lastMoved = new Set<number>();
	let random = cycle * 7_919 + 1;
	const next = () => hash(random++);
	const key = ([x, y, z]: Cell3) => ((z + 1) * rows + y) * columns + x;
	for (let step = 0; step < PUZZLE_STEPS; step++) {
		const occupied = new Set(positions.map(key));
		const nextPositions = [...positions];
		const moved = new Set<number>();
		const moveCount = model.puzzleMoves(next());
		for (let move = 0; move < moveCount; move++) {
			const candidates: Array<{ block: number; target: Cell3 }> = [];
			for (let block = 0; block < positions.length; block++) {
				if (moved.has(block)) continue;
				const [x, y, z] = positions[block]!;
				for (const [dx, dy, dz] of PUZZLE_MOVES) {
					const target: Cell3 = [x + dx, y + dy, z + dz];
					if (target[0] < 0 || target[0] >= columns || target[1] < 0 || target[1] >= rows) continue;
					if (target[2] < -1 || target[2] > 1 || occupied.has(key(target))) continue;
					candidates.push({ block, target });
				}
			}
			// 优先选择刚未移动过的方块，避免拼图看起来像一块方块在抖动。
			const fresh = candidates.filter((candidate) => !lastMoved.has(candidate.block));
			const pool = fresh.length > 0 ? fresh : candidates;
			const choice = pool[Math.floor(next() * pool.length)];
			if (!choice) break;
			occupied.add(key(choice.target));
			nextPositions[choice.block] = choice.target;
			moved.add(choice.block);
		}
		lastMoved.clear();
		for (const block of moved) lastMoved.add(block);
		positions = nextPositions;
		steps.push(positions);
	}
	return steps;
}

const FRAME_MS = 1000 / 30;
const DUST_DURATION = 0.35;
const WAVE_SPREAD = 0.55;
const WAVE_JITTER = 0.12;
const DISSOLVE_END = FLY_START + WAVE_SPREAD + WAVE_JITTER + DUST_DURATION;
const BACKGROUND_FADE = 0.5;
const EXIT_DURATION = 1.1;
// 屏幕消散后，logo 背后淡入一片暗淡的星空。
const STARS_START = 2.5;
const STARS_FADE = 2;
const STAR_DENSITY = 0.018;
// 星星的着色：中性、淡蓝、淡金、淡玫瑰，各与终端前景色混合一半。
const STAR_TINTS: Rgb[] = [
	[255, 255, 255],
	[170, 195, 255],
	[255, 225, 170],
	[255, 190, 205],
];
const LOGO_COLOR_STEP = 5;
// 在浅色背景上，盲文单元格的大部分面积显示明亮的背景，会把 logo 冲淡。此时 logo 会获得一圈
// 光晕：它的颜色和覆盖被模糊到单元格背景中，logo 正下方最强，然后在 HALO_RADIUS_X 列和
// HALO_RADIUS_Y 行范围内渐隐（单元格高度约为宽度的两倍）。
const LIGHT_HALO_STRENGTH = 0.3;
const HALO_RADIUS_X = 6;
const HALO_RADIUS_Y = 3;
const HALO_LEVELS = 32;
const STAR_ALPHA_LEVELS = 8;
const STAR_FLICKER_LEVELS = 3;
const HINT_FADE = 0.5;

// 盲文点位，按 2x4 单元格内的 row * 2 + column 索引。
const DOT_BITS = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
const BRAILLE = Array.from({ length: 256 }, (_, bits) => String.fromCharCode(0x2800 + bits));
const LIGHT = normalize([-0.45, -0.6, 0.75]);
const HALF_VECTOR = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

function normalize(v: readonly [number, number, number]): [number, number, number] {
	const length = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / length, v[1] / length, v[2] / length];
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 五次 smoothstep。 */
function smooth(value: number): number {
	const t = clamp01(value);
	return t * t * t * (t * (t * 6 - 15) + 10);
}

function easeOut(value: number): number {
	const t = 1 - clamp01(value);
	return 1 - t * t * t;
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
	return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount];
}

function hash(value: number): number {
	let x = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b);
	x ^= x >>> 13;
	x = Math.imul(x, 0xc2b2ae35);
	x ^= x >>> 16;
	return (x >>> 0) / 0x100000000;
}

/** 按相对亮度判断背景是否为浅色。 */
function isLight([r, g, b]: Rgb): boolean {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128;
}

function toRgb(color: Color): Rgb {
	const { r, g, b } = colorToRgb(color);
	return [r, g, b];
}

/** 字形会变成的盲文点数，大致衡量它的墨量。 */
function glyphInk(text: string, seed: number): number {
	if (text.trim() === "") return 0;
	if (/^[.,:;'`\-_·]$/.test(text)) return 2;
	if (/^[\u2500-\u257f]$/.test(text)) return 3;
	return 4 + Math.floor(seed * 3);
}

const segmenter = new Intl.Segmenter();

/** 把渲染后的行解析为带已解析颜色的单元格。其他转义序列（OSC、APC、光标）被跳过。 */
function parseScreen(
	lines: readonly string[],
	width: number,
	foreground: Rgb,
	background: Rgb,
): Array<Array<ScreenCell>> {
	const palette = (index: number): Rgb => toRgb(indexedColor(index));
	return lines.map((line) => {
		const cells: ScreenCell[] = [];
		let fg: Rgb | undefined;
		let bg: Rgb | undefined;
		let dim = false;
		let inverse = false;
		const applySgr = (params: string) => {
			const codes = params === "" ? ["0"] : params.split(";");
			for (let i = 0; i < codes.length; i++) {
				const parts = codes[i]!.split(":").map((part) => Number.parseInt(part, 10));
				const code = parts[0] ?? 0;
				if (code === 38 || code === 48) {
					// 扩展颜色，形式为 `38;5;n` / `38;2;r;g;b` 或冒号子参数。
					let args: number[];
					if (parts.length > 1) {
						args = parts.slice(1).filter((part) => !Number.isNaN(part));
						// `38:2::r:g:b` 的色彩空间 id 为空，已在上面丢弃。
					} else {
						const kind = Number.parseInt(codes[i + 1] ?? "", 10);
						const count = kind === 5 ? 2 : kind === 2 ? 4 : 1;
						args = codes.slice(i + 1, i + 1 + count).map((part) => Number.parseInt(part, 10));
						i += count;
					}
					let color: Rgb | undefined;
					if (args[0] === 5 && args[1] !== undefined) color = palette(args[1]);
					else if (args[0] === 2 && args.length >= 4) color = [args[1]!, args[2]!, args[3]!];
					if (color) {
						if (code === 38) fg = color;
						else bg = color;
					}
				} else if (code === 0) {
					fg = undefined;
					bg = undefined;
					dim = false;
					inverse = false;
				} else if (code === 2) dim = true;
				else if (code === 22) dim = false;
				else if (code === 7) inverse = true;
				else if (code === 27) inverse = false;
				else if (code >= 30 && code <= 37) fg = palette(code - 30);
				else if (code >= 90 && code <= 97) fg = palette(code - 90 + 8);
				else if (code === 39) fg = undefined;
				else if (code >= 40 && code <= 47) bg = palette(code - 40);
				else if (code >= 100 && code <= 107) bg = palette(code - 100 + 8);
				else if (code === 49) bg = undefined;
			}
		};
		const pushText = (text: string) => {
			for (const { segment } of segmenter.segment(text)) {
				const glyphWidth = visibleWidth(segment);
				if (glyphWidth === 0 || cells.length + glyphWidth > width) continue;
				let cellFg = fg ?? foreground;
				let cellBg = bg;
				if (inverse) {
					cellFg = bg ?? background;
					cellBg = fg ?? foreground;
				}
				if (dim) cellFg = mix(cellFg, cellBg ?? background, 0.4);
				const cell = { text: segment, width: glyphWidth, fg: cellFg, bg: cellBg, delay: 0, ink: 0, seed: 0 };
				cells.push(cell);
				if (glyphWidth === 2) cells.push({ ...cell, text: "", width: 0 });
			}
		};
		let i = 0;
		while (i < line.length) {
			const sequenceStart = line.indexOf("\x1b", i);
			if (sequenceStart === -1) {
				pushText(line.slice(i));
				break;
			}
			if (sequenceStart > i) pushText(line.slice(i, sequenceStart));
			const kind = line[sequenceStart + 1];
			if (kind === "[") {
				let end = sequenceStart + 2;
				while (end < line.length && (line.charCodeAt(end) < 0x40 || line.charCodeAt(end) > 0x7e)) end++;
				if (line[end] === "m") applySgr(line.slice(sequenceStart + 2, end));
				i = end + 1;
			} else if (kind === "]" || kind === "_" || kind === "P" || kind === "^") {
				// 字符串序列以 BEL 或 ST（ESC \）结束。
				const bell = line.indexOf("\x07", sequenceStart + 2);
				const st = line.indexOf("\x1b\\", sequenceStart + 2);
				if (bell === -1 && st === -1) break;
				i = bell !== -1 && (st === -1 || bell < st) ? bell + 1 : st + 2;
			} else {
				i = sequenceStart + 2;
			}
		}
		return cells;
	});
}

/** 行主序的 3x3 旋转矩阵：先 yaw（y），再 pitch（x），再 roll（z）。 */
function rotation(yaw: number, pitch: number, roll: number): number[] {
	const [sy, cy, sx, cx, sz, cz] = [
		Math.sin(yaw),
		Math.cos(yaw),
		Math.sin(pitch),
		Math.cos(pitch),
		Math.sin(roll),
		Math.cos(roll),
	];
	// Rz * Rx * Ry
	const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
	const rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
	const rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
	return multiply(rz, multiply(rx, ry));
}

function multiply(a: number[], b: number[]): number[] {
	const result = new Array<number>(9);
	for (let row = 0; row < 3; row++) {
		for (let column = 0; column < 3; column++) {
			result[row * 3 + column] =
				a[row * 3]! * b[column]! + a[row * 3 + 1]! * b[3 + column]! + a[row * 3 + 2]! * b[6 + column]!;
		}
	}
	return result;
}

// 旋转与拼图锁定：每个循环转一圈，在每次保持阶段的中间正对相机。
const SPIN_RAMP = 1.4;
const SPIN_SPEED = (Math.PI * 2) / PUZZLE_CYCLE;
// 正对相机时旋转减速（背对时加速）的程度，取值 0 到 1。
const SPIN_LINGER = 0.6;
const FIRST_FRONT_VIEW = PUZZLE_START + PUZZLE_STEP * PUZZLE_STEPS + PUZZLE_RETURN + PUZZLE_HOLD / 2;

/** 从静止开始按 SPIN_RAMP 加速、随后以 SPIN_SPEED 匀速旋转的均匀旋转。 */
function baseSpinPhase(time: number): number {
	const elapsed = time - FLY_START;
	if (elapsed <= 0) return 0;
	const u = elapsed / SPIN_RAMP;
	// 五次 smoothstep 缓动曲线的积分。
	if (u < 1) return SPIN_SPEED * SPIN_RAMP * (u ** 6 - 3 * u ** 5 + 2.5 * u ** 4);
	return SPIN_SPEED * (SPIN_RAMP * 0.5 + elapsed - SPIN_RAMP);
}

// 飞行期间附加的旋转，使每个组装完成的正面视角处的相位都是整圈数。
const SPIN_ALIGNMENT = Math.PI * 2 - (baseSpinPhase(FIRST_FRONT_VIEW) % (Math.PI * 2));

/** 旋转相位：恰好在重组完成的 logo 正对相机时为整圈。 */
function spinPhase(time: number): number {
	return baseSpinPhase(time) + SPIN_ALIGNMENT * smooth((time - FLY_START) / FLY_DURATION);
}

/** logo 的 yaw。整圈处与相位一致，但会在那里停留，使 logo 从正面可读。 */
function spinAngle(time: number): number {
	const phase = spinPhase(time);
	return phase - SPIN_LINGER * Math.sin(phase);
}

interface Face {
	axis: number;
	/** `axis` 上对象空间的平面坐标。 */
	plane: number;
	uMin: number;
	uMax: number;
	vMin: number;
	vMax: number;
	/** 以盲文点表示的投影边界（含端点）。 */
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	red: number;
	green: number;
	blue: number;
}

/**
 * 把模型的方块渲染进盲文单元格。只绘制正对相机且未被相邻方块遮挡的面。
 * 每个面在其投影范围内光栅化——把每个点的射线与面的平面求交，用深度缓冲解决重叠。
 * 缓冲区在帧之间复用。
 */
class BlockRaster {
	/** 每个单元格的盲文点位。 */
	bits = new Uint8Array(0);
	/** 每个单元格的点亮的点数。 */
	counts = new Uint8Array(0);
	/** 每个单元格点亮的点的 RGB 之和。 */
	rgb = new Float32Array(0);
	/** 每个单元格的光晕着色强度，取值 0 到 1。仅在请求了光晕时才写入。 */
	haloAmount = new Float32Array(0);
	/** 每个单元格的光晕颜色。 */
	haloRgb = new Float32Array(0);
	private width = 0;
	private height = 0;
	/** 每个点最近命中的射线参数；越小越近。 */
	private depth = new Float32Array(0);
	/** 每个点最近命中的面索引 + 1，0 表示无命中。 */
	private faceIds = new Uint16Array(0);
	/** 上一帧写入的单元格，下一帧之前清除。 */
	private dirty: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
	/** 上一帧带光晕的单元格，下一帧之前清除。 */
	private haloDirty: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
	private readonly cameraDistance: number;

	constructor(cameraDistance: number) {
		this.cameraDistance = cameraDistance;
	}

	render(
		width: number,
		height: number,
		pose: Pose,
		boxes: readonly Box[],
		background: Rgb,
		haloStrength: number,
	): void {
		const dotWidth = width * 2;
		const dotHeight = height * 4;
		if (width !== this.width || height !== this.height) {
			this.width = width;
			this.height = height;
			this.bits = new Uint8Array(width * height);
			this.counts = new Uint8Array(width * height);
			this.rgb = new Float32Array(width * height * 3);
			this.haloAmount = new Float32Array(width * height);
			this.haloRgb = new Float32Array(width * height * 3);
			this.haloDirty = undefined;
			this.depth = new Float32Array(dotWidth * dotHeight).fill(Infinity);
			this.faceIds = new Uint16Array(dotWidth * dotHeight);
			this.dirty = undefined;
		} else if (this.dirty) {
			const { minX, minY, maxX, maxY } = this.dirty;
			for (let row = minY; row <= maxY; row++) {
				this.bits.fill(0, row * width + minX, row * width + maxX + 1);
				this.counts.fill(0, row * width + minX, row * width + maxX + 1);
				this.rgb.fill(0, (row * width + minX) * 3, (row * width + maxX + 1) * 3);
			}
			this.dirty = undefined;
		}
		if (this.haloDirty) {
			const { minX, minY, maxX, maxY } = this.haloDirty;
			for (let row = minY; row <= maxY; row++) {
				this.haloAmount.fill(0, row * width + minX, row * width + maxX + 1);
				this.haloRgb.fill(0, (row * width + minX) * 3, (row * width + maxX + 1) * 3);
			}
			this.haloDirty = undefined;
		}

		const m = rotation(pose.yaw, pose.pitch, pose.roll);
		const { centerX, centerY, scale } = pose;
		const cameraDistance = this.cameraDistance;
		// 相机位于相机空间中的 (0, 0, cameraDistance)；对象空间是其转置旋转。
		const origin = [m[6]! * cameraDistance, m[7]! * cameraDistance, m[8]! * cameraDistance];
		const light = isLight(background);
		const faces = this.visibleFaces(m, origin, pose, boxes, dotWidth, dotHeight, light);
		if (faces.length === 0) return;
		let minX = dotWidth;
		let minY = dotHeight;
		let maxX = -1;
		let maxY = -1;
		for (const face of faces) {
			minX = Math.min(minX, face.minX);
			minY = Math.min(minY, face.minY);
			maxX = Math.max(maxX, face.maxX);
			maxY = Math.max(maxY, face.maxY);
		}
		if (maxX < minX || maxY < minY) return;

		const depth = this.depth;
		const faceIds = this.faceIds;
		for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
			const face = faces[faceIndex]!;
			const a = face.axis;
			const u = (a + 1) % 3;
			const v = (a + 2) % 3;
			const originA = origin[a]!;
			const originU = origin[u]!;
			const originV = origin[v]!;
			// 射线方向在对象空间中关于点的位置是线性的，因此按点逐步累加。
			const stepA = m[a]! / scale;
			const stepU = m[u]! / scale;
			const stepV = m[v]! / scale;
			const sx = (face.minX + 0.5 - centerX) / scale;
			for (let dotY = face.minY; dotY <= face.maxY; dotY++) {
				const sy = (dotY + 0.5 - centerY) / scale;
				let directionA = m[a]! * sx + m[3 + a]! * sy - m[6 + a]! * cameraDistance;
				let directionU = m[u]! * sx + m[3 + u]! * sy - m[6 + u]! * cameraDistance;
				let directionV = m[v]! * sx + m[3 + v]! * sy - m[6 + v]! * cameraDistance;
				let index = dotY * dotWidth + face.minX;
				for (let dotX = face.minX; dotX <= face.maxX; dotX++, index++) {
					const t = (face.plane - originA) / directionA;
					if (t > 0 && t < depth[index]!) {
						const hitU = originU + t * directionU;
						const hitV = originV + t * directionV;
						if (hitU >= face.uMin && hitU <= face.uMax && hitV >= face.vMin && hitV <= face.vMax) {
							depth[index] = t;
							faceIds[index] = faceIndex + 1;
						}
					}
					directionA += stepA;
					directionU += stepU;
					directionV += stepV;
				}
			}
		}

		// 对命中的点上色，把它们打包进盲文单元格，并重置点缓冲区以备下一帧。
		const bits = this.bits;
		const counts = this.counts;
		const rgb = this.rgb;
		let cellMinX = width;
		let cellMinY = height;
		let cellMaxX = -1;
		let cellMaxY = -1;
		for (let dotY = minY; dotY <= maxY; dotY++) {
			let index = dotY * dotWidth + minX;
			for (let dotX = minX; dotX <= maxX; dotX++, index++) {
				const id = faceIds[index]!;
				if (id === 0) continue;
				const face = faces[id - 1]!;
				// 距相机更远的点略微向背景色淡出，以表现深度。
				const fog = clamp01(0.15 - cameraDistance * (1 - depth[index]!) * 0.12) * (light ? 0.5 : 1);
				faceIds[index] = 0;
				depth[index] = Infinity;
				const cellX = dotX >> 1;
				const cellY = dotY >> 2;
				const cell = cellY * width + cellX;
				bits[cell]! |= DOT_BITS[(dotY & 3) * 2 + (dotX & 1)];
				counts[cell]!++;
				rgb[cell * 3] += face.red + (background[0] - face.red) * fog;
				rgb[cell * 3 + 1] += face.green + (background[1] - face.green) * fog;
				rgb[cell * 3 + 2] += face.blue + (background[2] - face.blue) * fog;
				if (cellX < cellMinX) cellMinX = cellX;
				if (cellX > cellMaxX) cellMaxX = cellX;
				if (cellY < cellMinY) cellMinY = cellY;
				if (cellY > cellMaxY) cellMaxY = cellY;
			}
		}
		if (cellMaxX >= 0) this.dirty = { minX: cellMinX, minY: cellMinY, maxX: cellMaxX, maxY: cellMaxY };
		if (haloStrength > 0) this.renderHalo(haloStrength);
	}

	/**
	 * 用可分离的 tent 滤波器把 logo 的覆盖和颜色模糊到相邻单元格，使着色在
	 * logo 边缘之外平滑衰减。
	 */
	private renderHalo(strength: number): void {
		const cells = this.dirty;
		if (!cells) return;
		const { width, height, counts, rgb } = this;
		const minX = Math.max(0, cells.minX - HALO_RADIUS_X);
		const maxX = Math.min(width - 1, cells.maxX + HALO_RADIUS_X);
		const minY = Math.max(0, cells.minY - HALO_RADIUS_Y);
		const maxY = Math.min(height - 1, cells.maxY + HALO_RADIUS_Y);
		const regionWidth = maxX - minX + 1;
		const tent = (radius: number) => {
			const weights = Array.from({ length: radius * 2 + 1 }, (_, i) => radius + 1 - Math.abs(i - radius));
			const total = weights.reduce((sum, weight) => sum + weight, 0);
			return weights.map((weight) => weight / total);
		};
		const weightsX = tent(HALO_RADIUS_X);
		const weightsY = tent(HALO_RADIUS_Y);

		// 对包含 logo 的行做水平 pass：每个单元格的覆盖与预乘颜色。
		const rows = cells.maxY - cells.minY + 1;
		const horizontal = new Float32Array(rows * regionWidth * 4);
		for (let y = cells.minY; y <= cells.maxY; y++) {
			for (let x = minX; x <= maxX; x++) {
				let coverage = 0;
				let red = 0;
				let green = 0;
				let blue = 0;
				for (let dx = -HALO_RADIUS_X; dx <= HALO_RADIUS_X; dx++) {
					const sourceX = x + dx;
					if (sourceX < cells.minX || sourceX > cells.maxX) continue;
					const source = y * width + sourceX;
					const count = counts[source]!;
					if (count === 0) continue;
					const weight = weightsX[dx + HALO_RADIUS_X]! / 8;
					coverage += count * weight;
					red += rgb[source * 3]! * weight;
					green += rgb[source * 3 + 1]! * weight;
					blue += rgb[source * 3 + 2]! * weight;
				}
				const target = ((y - cells.minY) * regionWidth + (x - minX)) * 4;
				horizontal[target] = coverage;
				horizontal[target + 1] = red;
				horizontal[target + 2] = green;
				horizontal[target + 3] = blue;
			}
		}

		// 垂直 pass 写入光晕缓冲。
		for (let y = minY; y <= maxY; y++) {
			for (let x = minX; x <= maxX; x++) {
				let coverage = 0;
				let red = 0;
				let green = 0;
				let blue = 0;
				for (let dy = -HALO_RADIUS_Y; dy <= HALO_RADIUS_Y; dy++) {
					const sourceY = y + dy;
					if (sourceY < cells.minY || sourceY > cells.maxY) continue;
					const weight = weightsY[dy + HALO_RADIUS_Y]!;
					const source = ((sourceY - cells.minY) * regionWidth + (x - minX)) * 4;
					coverage += horizontal[source]! * weight;
					red += horizontal[source + 1]! * weight;
					green += horizontal[source + 2]! * weight;
					blue += horizontal[source + 3]! * weight;
				}
				const target = y * width + x;
				// logo 下方的单元格至少保留自己的覆盖，使表面保持实色着色。
				const count = counts[target]!;
				if (count > 0 && count / 8 > coverage) {
					coverage = count / 8;
					red = (rgb[target * 3]! / count) * coverage;
					green = (rgb[target * 3 + 1]! / count) * coverage;
					blue = (rgb[target * 3 + 2]! / count) * coverage;
				}
				if (coverage <= 0) continue;
				// 做了量化，使相邻单元格通常共享同一个背景及其转义序列。
				const amount = Math.round(strength * Math.min(1, coverage) ** 0.7 * HALO_LEVELS) / HALO_LEVELS;
				if (amount <= 0) continue;
				this.haloAmount[target] = amount;
				this.haloRgb[target * 3] = Math.round(red / coverage / LOGO_COLOR_STEP) * LOGO_COLOR_STEP;
				this.haloRgb[target * 3 + 1] = Math.round(green / coverage / LOGO_COLOR_STEP) * LOGO_COLOR_STEP;
				this.haloRgb[target * 3 + 2] = Math.round(blue / coverage / LOGO_COLOR_STEP) * LOGO_COLOR_STEP;
			}
		}
		this.haloDirty = { minX, minY, maxX, maxY };
	}

	private visibleFaces(
		m: number[],
		origin: number[],
		pose: Pose,
		boxes: readonly Box[],
		dotWidth: number,
		dotHeight: number,
		lightBackground: boolean,
	): Face[] {
		const faces: Face[] = [];
		const cameraDistance = this.cameraDistance;
		for (const box of boxes) {
			for (let a = 0; a < 3; a++) {
				const u = (a + 1) % 3;
				const v = (a + 2) % 3;
				for (const side of [-1, 1]) {
					const plane = side > 0 ? box.max[a]! : box.min[a]!;
					// 背面朝向相机，加以剔除。
					if ((origin[a]! - plane) * side <= 0) continue;
					// 与相邻方块贴合的面被遮挡。方块静止时位置是精确的。
					const covered = boxes.some(
						(other) =>
							other !== box &&
							(side > 0 ? other.min[a] : other.max[a]) === plane &&
							other.min[u]! <= box.min[u]! &&
							other.max[u]! >= box.max[u]! &&
							other.min[v]! <= box.min[v]! &&
							other.max[v]! >= box.max[v]!,
					);
					if (covered) continue;

					let minX = Infinity;
					let minY = Infinity;
					let maxX = -Infinity;
					let maxY = -Infinity;
					const corner = [0, 0, 0];
					for (const cornerU of [box.min[u]!, box.max[u]!]) {
						for (const cornerV of [box.min[v]!, box.max[v]!]) {
							corner[a] = plane;
							corner[u] = cornerU;
							corner[v] = cornerV;
							const x = m[0]! * corner[0]! + m[1]! * corner[1]! + m[2]! * corner[2]!;
							const y = m[3]! * corner[0]! + m[4]! * corner[1]! + m[5]! * corner[2]!;
							const z = m[6]! * corner[0]! + m[7]! * corner[1]! + m[8]! * corner[2]!;
							const perspective = (pose.scale * cameraDistance) / (cameraDistance - z);
							const screenX = pose.centerX + x * perspective;
							const screenY = pose.centerY + y * perspective;
							minX = Math.min(minX, screenX);
							minY = Math.min(minY, screenY);
							maxX = Math.max(maxX, screenX);
							maxY = Math.max(maxY, screenY);
						}
					}
					const face = {
						minX: Math.max(0, Math.floor(minX)),
						minY: Math.max(0, Math.floor(minY)),
						maxX: Math.min(dotWidth - 1, Math.ceil(maxX)),
						maxY: Math.min(dotHeight - 1, Math.ceil(maxY)),
					};
					if (face.maxX < face.minX || face.maxY < face.minY) continue;

					// 面是平的，因此光照按面只计算一次。相机空间中的法线
					// 是旋转矩阵的一列。
					const nx = m[a]! * side;
					const ny = m[3 + a]! * side;
					const nz = m[6 + a]! * side;
					const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
					const rim = Math.max(0, nx * 0.8 - nz * 0.3);
					// 在浅色背景上，朝白色的高光会消失，因此那里的面只会比
					// 品牌色更暗。
					const specular = lightBackground
						? 0
						: Math.max(0, nx * HALF_VECTOR[0] + ny * HALF_VECTOR[1] + nz * HALF_VECTOR[2]) ** 24 * 0.6 * 255;
					const light = lightBackground
						? Math.min(1, 0.55 + diffuse * 0.45 + rim * 0.1)
						: 0.45 + diffuse * 0.78 + rim * 0.25;
					faces.push({
						axis: a,
						plane,
						uMin: box.min[u]!,
						uMax: box.max[u]!,
						vMin: box.min[v]!,
						vMax: box.max[v]!,
						...face,
						red: Math.min(255, box.color[0] * light + specular),
						green: Math.min(255, box.color[1] * light + specular),
						blue: Math.min(255, box.color[2] * light + specular),
					});
				}
			}
		}
		return faces;
	}
}

/**
 * 要播放哪个彩蛋。pi logo 从头部 logo 处飞起，其左上单元格位于 `column`、`row`。
 */
export type EasterEgg3d = { kind: "pi-logo"; column: number; row: number } | { kind: "armin" };

let playing = false;

/**
 * 以全屏覆盖层展示动画，直到它被关闭。覆盖层会取得焦点和鼠标输入，隐藏时归还焦点，
 * 因此其余 UI 在其下不受影响地继续运行。
 */
export async function playEasterEgg3d(tui: TUI, screen: readonly string[], egg: EasterEgg3d): Promise<void> {
	if (playing) return;
	playing = true;
	// 淡入淡出需要终端真实的默认颜色；主题只知道自己的颜色。
	const reported = await tui.queryTerminalColors({ timeoutMs: 100 });
	const dark = theme.appearance === "dark";
	const toRgbTuple = (rgb: { r: number; g: number; b: number } | undefined, fallback: Rgb): Rgb =>
		rgb ? [rgb.r, rgb.g, rgb.b] : fallback;
	const colors = {
		foreground: toRgbTuple(reported.foreground, toRgb(theme.colors.text)),
		background: toRgbTuple(reported.background, dark ? [0, 0, 0] : [255, 255, 255]),
	};
	if (tui.hasOverlay()) {
		playing = false;
		return;
	}
	const model =
		egg.kind === "armin" ? arminModel(toRgb(theme.colors.accent)) : piLogoModel({ column: egg.column, row: egg.row });
	const animation = new EasterEgg3dAnimation(tui, screen, model, colors, () => {
		playing = false;
		overlay.hide();
	});
	const overlay = tui.showOverlay(animation, { anchor: "top-left", width: "100%", maxHeight: "100%" });
}

export class EasterEgg3dAnimation implements Component {
	private readonly tui: TUI;
	/** 要消散的屏幕，以渲染后的行表示。 */
	private readonly screen: readonly string[];
	private readonly model: Model;
	private readonly foreground: Rgb;
	private readonly background: Rgb;
	private readonly onDone: () => void;
	private readonly startTime = performance.now();
	private lastRender = performance.now();
	private timer: ReturnType<typeof setInterval> | undefined;
	private exit:
		| { start: number; time: number; yaw: number; targetYaw: number; offsets: Array<[number, number, number]> }
		| undefined;
	private shuffle: { cycle: number; steps: Cell3[][] } | undefined;
	private screenWidth = -1;
	private screenHeight = -1;
	/** 每个单元格索引的星星，或 undefined。 */
	private stars: Array<Star | undefined> = [];
	private cells: ScreenCell[][] = [];
	private readonly ansiCache = new Map<number, string>();
	private readonly raster: BlockRaster;

	constructor(
		tui: TUI,
		screen: readonly string[],
		model: Model,
		colors: { foreground: Rgb; background: Rgb },
		onDone: () => void,
	) {
		this.tui = tui;
		this.screen = screen;
		this.model = model;
		this.raster = new BlockRaster(model.cameraDistance);
		this.foreground = colors.foreground;
		this.background = colors.background;
		this.onDone = onDone;
		this.timer = setInterval(() => {
			// 不再被渲染时也要停止，例如 pi 在退出时隐藏所有覆盖层。
			if ((this.exit && this.exitProgress() >= 1) || performance.now() - this.lastRender > 1000) this.finish();
			else this.tui.requestRender();
		}, FRAME_MS);
		this.timer.unref?.();
	}

	/** 播放退出动画。再次调用则直接跳过。 */
	close(): void {
		if (this.exit) {
			this.finish();
			return;
		}
		const time = this.elapsed();
		const yaw = spinAngle(time);
		const turn = Math.PI * 2;
		this.exit = {
			start: performance.now(),
			time,
			yaw,
			targetYaw: Math.ceil(yaw / turn) * turn,
			offsets: this.blockOffsets(time),
		};
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.clear")) this.close();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		if (event.type === "click") this.close();
		return { handled: true, render: false };
	}

	invalidate(): void {
		this.screenWidth = -1;
		this.screenHeight = -1;
		this.ansiCache.clear();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows);
		const foreground = this.foreground;
		const background = this.background;
		this.lastRender = performance.now();
		if (width !== this.screenWidth || height !== this.screenHeight) {
			this.screenWidth = width;
			this.screenHeight = height;
			this.cells = this.prepareCells(width, foreground);
			this.stars = this.prepareStars(width, height);
		}

		// 消散时间在进入时正向运行、退出时反向运行，因此屏幕以相反顺序复原。
		let dissolveTime: number;
		let pose: Pose;
		let hintAlpha: number;
		let starAlpha: number;
		let offsets: Array<[number, number, number]>;
		if (this.exit) {
			const progress = this.exitProgress();
			const landing = clamp01(progress / 0.8);
			const settle = 1 - smooth(landing);
			dissolveTime = Math.min(this.exit.time, DISSOLVE_END) * (1 - progress);
			pose = this.pose(width, height, this.flyProgress(this.exit.time) * settle, this.exit.time);
			pose.yaw = this.exit.yaw + (this.exit.targetYaw - this.exit.yaw) * easeOut(landing);
			pose.pitch *= settle;
			pose.roll *= settle;
			hintAlpha = this.hintAlpha(this.exit.time) * (1 - smooth(progress / 0.2));
			starAlpha = this.starAlpha(this.exit.time) * (1 - smooth(progress / 0.3));
			// 在 logo 落回之前，方块早已各就各位。
			const gather = 1 - smooth(progress / 0.5);
			offsets = this.exit.offsets.map(([x, y, z]) => [x * gather, y * gather, z * gather]);
		} else {
			const time = this.elapsed();
			dissolveTime = time;
			pose = this.pose(width, height, this.flyProgress(time), time);
			hintAlpha = this.hintAlpha(time);
			starAlpha = this.starAlpha(time);
			offsets = this.blockOffsets(time);
		}

		const { columns, rows } = this.model;
		const boxes: Box[] = this.model.blocks.map((block, index) => {
			const [dx, dy, dz] = offsets[index]!;
			const x = block.home[0] - columns / 2 + dx;
			const y = block.home[1] - rows / 2 + dy;
			return { min: [x, y, dz - DEPTH / 2], max: [x + 1, y + 1, dz + DEPTH / 2], color: block.color };
		});
		const raster = this.raster;
		raster.render(width, height, pose, boxes, background, isLight(background) ? LIGHT_HALO_STRENGTH : 0);
		const halo = (index: number, base: Rgb | undefined): Rgb | undefined => {
			const amount = raster.haloAmount[index]!;
			if (amount <= 0) return base;
			const color = raster.haloRgb;
			return mix(base ?? background, [color[index * 3]!, color[index * 3 + 1]!, color[index * 3 + 2]!], amount);
		};
		const backgroundFade = smooth(dissolveTime / BACKGROUND_FADE);
		const textFade = smooth(dissolveTime / 0.6) * 0.3;
		// 屏幕完全消散后，文本层已为空，可以跳过。
		const textActive = dissolveTime < DISSOLVE_END || backgroundFade < 1;
		const hint = this.hint(width, height, hintAlpha, background);
		const frame = Math.floor(dissolveTime * 14);
		const now = this.elapsed();
		// 星星亮度做了量化，因此某一行只有在其中一颗星星跳到另一档时才会变化，
		// 而不是每帧都变。
		const starLevel = Math.round(starAlpha * STAR_ALPHA_LEVELS) / STAR_ALPHA_LEVELS;
		const starfield = (index: number): { text: string; fg: Rgb } | undefined => {
			if (starLevel <= 0) return undefined;
			const star = this.stars[index];
			if (!star) return undefined;
			const flicker =
				Math.round((0.5 + 0.5 * Math.sin(now * star.speed + star.phase)) * STAR_FLICKER_LEVELS) /
				STAR_FLICKER_LEVELS;
			return {
				text: star.glyph,
				fg: mix(background, mix(foreground, star.tint, 0.5), star.strength * (0.7 + 0.3 * flicker) * starLevel),
			};
		};
		const lines: string[] = [];
		for (let row = 0; row < height; row++) {
			const cells = this.cells[row] ?? [];
			let line = "";
			let currentFg = -1;
			let currentBg = -1;
			const emit = (text: string, fg: Rgb | undefined, bg: Rgb | undefined) => {
				const fgKey = fg ? this.pack(fg) : -1;
				const bgKey = bg ? this.pack(bg) : -1;
				if (fgKey !== currentFg && text !== " ") {
					line += fg ? this.ansi(fgKey, false) : "\x1b[39m";
					currentFg = fgKey;
				}
				if (bgKey !== currentBg) {
					line += bg ? this.ansi(bgKey, true) : "\x1b[49m";
					currentBg = bgKey;
				}
				line += text;
			};
			for (let column = 0; column < width; column++) {
				const index = row * width + column;
				const cell = textActive ? cells[column] : undefined;
				const cellBg = halo(
					index,
					cell?.bg && backgroundFade < 1 ? mix(cell.bg, background, backgroundFade) : undefined,
				);
				if (hint && row === hint.row && column >= hint.start && column < hint.start + hint.text.length) {
					const offset = column - hint.start;
					emit(hint.text[offset]!, offset < hint.keyLength ? hint.keyColor : hint.color, cellBg);
					continue;
				}
				const dots = raster.bits[index]!;
				if (dots) {
					// 做了量化，使同一个面上的相邻单元格通常共享一个颜色及其转义序列。
					const step = LOGO_COLOR_STEP * raster.counts[index]!;
					const rgb = raster.rgb;
					const color: Rgb = [
						Math.round(rgb[index * 3]! / step) * LOGO_COLOR_STEP,
						Math.round(rgb[index * 3 + 1]! / step) * LOGO_COLOR_STEP,
						Math.round(rgb[index * 3 + 2]! / step) * LOGO_COLOR_STEP,
					];
					emit(BRAILLE[dots]!, color, cellBg);
					continue;
				}
				if (!cell) {
					const star = starfield(index);
					emit(star?.text ?? " ", star?.fg, cellBg);
					continue;
				}
				const dust = (dissolveTime - cell.delay) / DUST_DURATION;
				if (dust < 0 && cell.width === 2 && !raster.bits[index + 1]) {
					emit(cell.text, mix(cell.fg, background, textFade), cellBg);
					column++;
					continue;
				}
				if (dust < 0 && cell.width === 1) {
					emit(cell.text, mix(cell.fg, background, textFade), cellBg);
					continue;
				}
				const dotCount = dust < 0 ? cell.ink : Math.round(cell.ink * (1 - clamp01(dust)));
				if (dotCount <= 0) {
					const star = starfield(index);
					emit(star?.text ?? " ", star?.fg, cellBg);
					continue;
				}
				// 选取 `dotCount` 个互不相同的点；选择每秒变化几次，让尘埃闪烁。
				let bits = 0;
				let placed = 0;
				for (let attempt = 0; placed < dotCount && attempt < 32; attempt++) {
					const bit = DOT_BITS[Math.floor(hash(cell.seed * 7919 + frame * 131 + attempt) * 8)]!;
					if (bits & bit) continue;
					bits |= bit;
					placed++;
				}
				const fade = textFade + (1 - textFade) * clamp01(dust) ** 0.8;
				emit(BRAILLE[bits]!, mix(cell.fg, background, fade), cellBg);
			}
			lines.push(`${line}\x1b[0m`);
		}
		return lines;
	}

	private elapsed(): number {
		return (performance.now() - this.startTime) / 1000;
	}

	private exitProgress(): number {
		return this.exit ? clamp01((performance.now() - this.exit.start) / 1000 / EXIT_DURATION) : 0;
	}

	private finish(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
		this.onDone();
	}

	/** 每个方块在 `time` 时刻相对其在模型中位置的位移，单位为网格。 */
	private blockOffsets(time: number): Array<[number, number, number]> {
		const blocks = this.model.blocks;
		const home = (): Array<[number, number, number]> => blocks.map(() => [0, 0, 0]);
		if (time < PUZZLE_START) return home();
		const cycle = Math.floor((time - PUZZLE_START) / PUZZLE_CYCLE);
		const local = time - PUZZLE_START - cycle * PUZZLE_CYCLE;
		if (this.shuffle?.cycle !== cycle) this.shuffle = { cycle, steps: shuffleSteps(this.model, cycle) };
		const steps = this.shuffle.steps;
		const offset = (position: Cell3, index: number): [number, number, number] => {
			const block = blocks[index]!.home;
			return [position[0] - block[0], position[1] - block[1], position[2] - block[2]];
		};
		const shuffleEnd = PUZZLE_STEP * PUZZLE_STEPS;
		if (local < shuffleEnd) {
			const step = Math.floor(local / PUZZLE_STEP);
			const progress = smooth((local - step * PUZZLE_STEP) / PUZZLE_STEP);
			return steps[step]!.map((from, index) => {
				const a = offset(from, index);
				const b = offset(steps[step + 1]![index]!, index);
				return [a[0] + (b[0] - a[0]) * progress, a[1] + (b[1] - a[1]) * progress, a[2] + (b[2] - a[2]) * progress];
			});
		}
		if (local < shuffleEnd + PUZZLE_RETURN) {
			// 所有方块同时飞回原位。深度方向交替的弧线让它们互不穿过。
			const u = (local - shuffleEnd) / PUZZLE_RETURN;
			const remaining = 1 - smooth(u);
			const arc = Math.sin(Math.PI * clamp01(u)) * 0.8;
			return steps[PUZZLE_STEPS]!.map((position, index) => {
				const [x, y, z] = offset(position, index);
				return [x * remaining, y * remaining, z * remaining + (index % 2 === 0 ? arc : -arc)];
			});
		}
		return home();
	}

	private flyProgress(time: number): number {
		return smooth((time - FLY_START) / FLY_DURATION);
	}

	private starAlpha(time: number): number {
		return smooth((time - STARS_START) / STARS_FADE);
	}

	private hintAlpha(time: number): number {
		return smooth((time - FLY_START - FLY_DURATION) / HINT_FADE);
	}

	private pose(width: number, height: number, progress: number, time: number): Pose {
		const { columns, rows, cameraDistance, radius, widthShare, origin } = this.model;
		const reach = radius * (cameraDistance / (cameraDistance - radius));
		// 飞起时，正面必须精确覆盖半块单元格（每像素 2x2 个点），即使存在透视。
		const startScale = origin ? (2 * (cameraDistance - DEPTH / 2)) / cameraDistance : START_SCALE;
		const endScale = Math.max(startScale, Math.min(width * 2 * widthShare, (height * 4 - 8) * 0.48) / reach);
		const endX = width;
		const endY = height * 2 - 2;
		const startX = origin ? origin.column * 2 + columns : endX;
		const startY = origin ? origin.row * 4 + rows : endY;
		return {
			centerX: startX + (endX - startX) * progress,
			centerY: startY + (endY - startY) * progress,
			// 缩放按几何方式插值，让感觉上均匀一致。
			scale: startScale * (endScale / startScale) ** progress,
			yaw: spinAngle(time),
			// 整圈处倾斜为零，因此相机正对重组完成的 logo 的正面。
			pitch: 0.3 * Math.sin(spinPhase(time)) * progress,
			roll: 0.06 * Math.sin(2 * spinPhase(time)) * progress,
		};
	}

	private hint(
		width: number,
		height: number,
		alpha: number,
		background: Rgb,
	): { row: number; start: number; text: string; keyLength: number; keyColor: Rgb; color: Rgb } | undefined {
		if (alpha <= 0) return undefined;
		const key = formatKeyText(getKeybindings().getKeys("tui.select.cancel")[0] ?? "escape");
		const text = `${key} to return`;
		if (text.length > width) return undefined;
		return {
			row: height - 2,
			start: Math.floor((width - text.length) / 2),
			text,
			keyLength: key.length,
			keyColor: mix(background, toRgb(theme.colors.muted), alpha),
			color: mix(background, toRgb(theme.colors.dim), alpha),
		};
	}

	/** 稀疏且确定的星空：约 STAR_DENSITY 比例的单元格中有一颗盲文点。 */
	private prepareStars(width: number, height: number): Array<Star | undefined> {
		const stars = new Array<Star | undefined>(width * height);
		for (let index = 0; index < width * height; index++) {
			if (hash(index * 3 + 0x51ed) >= STAR_DENSITY) continue;
			const random = (salt: number) => hash(index * 7 + salt * 0x9e37);
			stars[index] = {
				glyph: BRAILLE[DOT_BITS[Math.floor(random(1) * 8)]!]!,
				tint: STAR_TINTS[Math.floor(random(2) * STAR_TINTS.length)]!,
				strength: 0.1 + random(3) * 0.12,
				phase: random(4) * Math.PI * 2,
				speed: 0.4 + random(5) * 0.8,
			};
		}
		return stars;
	}

	private prepareCells(width: number, foreground: Rgb): ScreenCell[][] {
		const cells = parseScreen(this.screen, width, foreground, this.background);
		const height = Math.max(1, this.tui.terminal.rows);
		const { columns, rows, origin } = this.model;
		// 尘埃从模型起始处向外扩散。
		const centerX = origin ? origin.column + columns / 2 : width / 2;
		const centerY = origin ? origin.row + rows / 4 : height / 2;
		const farthest = Math.hypot(Math.max(centerX, width - centerX), Math.max(centerY, height - centerY) * 2);
		for (let row = 0; row < cells.length; row++) {
			const line = cells[row]!;
			for (let column = 0; column < line.length; column++) {
				const cell = line[column]!;
				// 宽字素与首列共用时间，让两半同时变化。
				const owner = cell.width === 0 ? line[column - 1]! : cell;
				const seed = hash(row * 65_537 + column);
				if (cell.width !== 0) {
					const distance = Math.hypot(column - centerX, (row - centerY) * 2) / farthest;
					cell.delay = FLY_START + distance * WAVE_SPREAD + seed * WAVE_JITTER;
				} else {
					cell.delay = owner.delay;
				}
				cell.seed = row * 65_537 + column;
				cell.ink = glyphInk(owner.text, seed);
			}
		}
		// 3D 模型会取代它在屏幕上的半块渲染。
		if (origin) {
			for (let row = origin.row; row < origin.row + Math.ceil(rows / 2); row++) {
				const line = cells[row];
				if (!line) continue;
				for (let column = origin.column; column < origin.column + columns; column++) {
					const cell = line[column];
					if (cell) {
						cell.text = " ";
						cell.width = 1;
						cell.ink = 0;
						cell.bg = undefined;
					}
				}
			}
		}
		return cells;
	}

	private pack(color: Rgb): number {
		return (Math.round(color[0]) << 16) | (Math.round(color[1]) << 8) | Math.round(color[2]);
	}

	private ansi(key: number, isBackground: boolean): string {
		const cacheKey = key * 2 + (isBackground ? 1 : 0);
		let value = this.ansiCache.get(cacheKey);
		if (value === undefined) {
			const color = rgbColor((key >> 16) & 255, (key >> 8) & 255, key & 255);
			const mode = theme.getColorMode();
			value = isBackground ? backgroundAnsi(color, mode) : foregroundAnsi(color, mode);
			this.ansiCache.set(cacheKey, value);
		}
		return value;
	}
}
