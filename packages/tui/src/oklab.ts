/**
 * Oklab、OKHSL 与 sRGB 之间的转换。`colors.ts` 基于此实现 OKLCH、OKHSL 和颜色混合。
 *
 * Oklab 和 OKHSL 是 Björn Ottosson 提出的颜色空间；OKHSL 的饱和度相对于每种色相和亮度下的 sRGB 色域定义。
 * 此实现移植自他的参考实现（https://bottosson.github.io/posts/colorpicker/）。
 * Copyright (c) 2021 Björn Ottosson, used under the MIT license:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 * following conditions: The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED.
 */

import type { RgbColor } from "./terminal-colors.ts";

type Vector = [number, number, number];
type Matrix = [Vector, Vector, Vector];

const multiply = (m: Matrix, [x, y, z]: Vector): Vector =>
	m.map((row) => row[0] * x + row[1] * y + row[2] * z) as Vector;

// ============================================================================
// OKHSL 与 sRGB 之间的转换。
// ============================================================================

const LINEAR_SRGB_TO_LMS: Matrix = [
	[0.4122214694707629, 0.5363325372617349, 0.0514459932675022],
	[0.2119034958178251, 0.6806995506452344, 0.1073969535369405],
	[0.0883024591900564, 0.2817188391361215, 0.6299787016738222],
];
const LMS_TO_LAB: Matrix = [
	[0.210454268309314, 0.793617774702305, -0.0040720430116193],
	[1.9779985324311684, -2.42859224204858, 0.450593709617411],
	[0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const LAB_TO_LMS: Matrix = [
	[1, 0.3963377773761749, 0.2158037573099136],
	[1, -0.1055613458156586, -0.0638541728258133],
	[1, -0.0894841775298119, -1.2914855480194092],
];
const LMS_TO_LINEAR_SRGB: Matrix = [
	[4.0767416360759583, -3.3077115392580629, 0.2309699031821043],
	[-1.2684379732850315, 2.6097573492876882, -0.341319376002657],
	[-0.0041960761386756, -0.7034186179359362, 1.7076146940746117],
];
/**
 * 对每个 sRGB 通道（红、绿、蓝），记录该通道最先发生裁剪时对应的 (a, b) 半平面，
 * 以及用于近似该区域最大饱和度的多项式。
 */
const SATURATION_FIT: [[number, number], number[]][] = [
	[
		[-1.8817031, -0.80936501],
		[1.19086277, 1.76576728, 0.59662641, 0.75515197, 0.56771245],
	],
	[
		[1.8144408, -1.19445267],
		[0.73956515, -0.45954404, 0.08285427, 0.12541073, -0.14503204],
	],
	[
		[0.13110758, 1.81333971],
		[1.35733652, -0.00915799, -1.1513021, -0.50559606, 0.00692167],
	],
];
const K1 = 0.206;
const K2 = 0.03;
const K3 = (1 + K1) / (1 + K2);

/** 将 Oklab 亮度转换为 OKHSL 亮度。 */
export const oklabToOkhslLightness = (x: number): number =>
	0.5 * (K3 * x - K1 + Math.sqrt((K3 * x - K1) ** 2 + 4 * K2 * K3 * x));
/** 将 OKHSL 亮度转换为 Oklab 亮度。 */
const okhslToOklabLightness = (x: number): number => (x * x + K1 * x) / (K3 * (x + K2));

/** sRGB 传递函数：将线性通道转换为编码通道，取值均为 0-1。 */
const linearToSrgb = (value: number): number =>
	value > 0.0031308 ? 1.055 * value ** (1 / 2.4) - 0.055 : 12.92 * value;
/** sRGB 逆传递函数：将编码通道转换为线性通道，取值均为 0-1。 */
const srgbToLinear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** 将 Oklab [L, a, b] 转换为线性 sRGB [r, g, b]（范围为 0-1，结果可能超出色域）。 */
export function oklabToLinearSrgb(lab: Vector): Vector {
	return multiply(LMS_TO_LINEAR_SRGB, multiply(LAB_TO_LMS, lab).map((value) => value ** 3) as Vector);
}

/** 将线性 sRGB [r, g, b]（范围为 0-1）转换为 Oklab [L, a, b]。 */
function linearSrgbToOklab(rgb: Vector): Vector {
	return multiply(LMS_TO_LAB, multiply(LINEAR_SRGB_TO_LMS, rgb).map(Math.cbrt) as Vector);
}

/** 将取值范围为 0-255 的 sRGB 通道转换为 Oklab [L, a, b]。 */
export function rgbToOklab({ r, g, b }: RgbColor): Vector {
	return linearSrgbToOklab([r / 255, g / 255, b / 255].map(srgbToLinear) as Vector);
}

/** 将线性 sRGB [r, g, b] 转换为 sRGB 通道（范围为 0-255，四舍五入），并裁剪超出色域的通道。 */
export function linearSrgbToRgb(linear: Vector): RgbColor {
	const [r, g, b] = linear.map((value) => Math.round(Math.min(1, Math.max(0, linearToSrgb(value))) * 255));
	return { r, g, b };
}

/** 沿色度方向 (a, b) 时，各 LMS 分量立方根的变化率。 */
function lmsSlopes(a: number, b: number): Vector {
	return [LAB_TO_LMS[0], LAB_TO_LMS[1], LAB_TO_LMS[2]].map((row) => row[1] * a + row[2] * b) as Vector;
}

/** 色相方向 (a, b) 在 sRGB 色域内允许的最大饱和度 (C/L)：多项式拟合后再执行一次 Halley 迭代。 */
function maxSaturation(a: number, b: number): number {
	const channel = SATURATION_FIT.findIndex(([[x, y]], index) => index === 2 || x * a + y * b > 1);
	const [k0, k1, k2, k3, k4] = SATURATION_FIT[channel][1];
	const weights = LMS_TO_LINEAR_SRGB[channel];
	const saturation = k0 + k1 * a + k2 * b + k3 * a * a + k4 * a * b;

	const slopes = lmsSlopes(a, b);
	const base = slopes.map((k) => 1 + saturation * k);
	const dot = (values: number[]) => values.reduce((sum, value, index) => sum + weights[index] * value, 0);
	const f = dot(base.map((value) => value ** 3));
	const f1 = dot(base.map((value, index) => 3 * slopes[index] * value ** 2));
	const f2 = dot(base.map((value, index) => 6 * slopes[index] ** 2 * value));
	return saturation - (f * f1) / (f1 * f1 - 0.5 * f * f2);
}

/** 色相方向 (a, b) 上最鲜艳 sRGB 颜色的 Oklab 亮度和色度。 */
function cusp(a: number, b: number): [number, number] {
	const saturation = maxSaturation(a, b);
	const lightness = Math.cbrt(1 / Math.max(...oklabToLinearSrgb([1, saturation * a, saturation * b])));
	return [lightness, lightness * saturation];
}

/** 亮度为 `lightness` 的等亮度线离开 sRGB 色域时对应的色度。 */
function maxChroma(a: number, b: number, lightness: number, [cuspL, cuspC]: [number, number]): number {
	if (lightness <= cuspL) return (cuspC * lightness) / cuspL;
	// 上半区域：先求三角形边界，再针对每个达到 1 的通道执行一次 Halley 迭代。
	const t = (cuspC * (lightness - 1)) / (cuspL - 1);
	const slopes = lmsSlopes(a, b);
	const lms = slopes.map((k) => lightness + t * k);
	const cubes = lms.map((value) => value ** 3);
	const first = lms.map((value, index) => 3 * slopes[index] * value ** 2);
	const second = lms.map((value, index) => 6 * slopes[index] ** 2 * value);
	const dot = (row: Vector, values: number[]) => row[0] * values[0] + row[1] * values[1] + row[2] * values[2];
	const steps = LMS_TO_LINEAR_SRGB.map((row) => {
		const f = dot(row, cubes) - 1;
		const f1 = dot(row, first);
		const f2 = dot(row, second);
		const u = f1 / (f1 * f1 - 0.5 * f * f2);
		return u >= 0 ? -f * u : Number.MAX_VALUE;
	});
	return t + Math.min(...steps);
}

/** OKHSL 在亮度 L 和色相 (a, b) 下的色度参考点：[c0, cMid, cMax]。 */
function chromaStops(L: number, a: number, b: number): [number, number, number] {
	const peak = cusp(a, b);
	const cMax = maxChroma(a, b, L, peak);
	const k = cMax / Math.min(L * (peak[1] / peak[0]), (1 - L) * (peak[1] / (1 - peak[0])));
	const midS =
		0.11516993 +
		1 /
			(7.4477897 +
				4.1590124 * b +
				a *
					(-2.19557347 +
						1.75198401 * b +
						a * (-2.13704948 - 10.02301043 * b + a * (-4.24894561 + 5.38770819 * b + 4.69891013 * a))));
	const midT =
		0.11239642 +
		1 /
			(1.6132032 -
				0.68124379 * b +
				a *
					(0.40370612 +
						0.90148123 * b +
						a * (-0.27087943 + 0.6122399 * b + a * (0.00299215 - 0.45399568 * b - 0.14661872 * a))));
	const cMid = 0.9 * k * Math.sqrt(Math.sqrt(1 / (1 / (L * midS) ** 4 + 1 / ((1 - L) * midT) ** 4)));
	const c0 = Math.sqrt(1 / (1 / (L * 0.4) ** 2 + 1 / ((1 - L) * 0.8) ** 2));
	return [c0, cMid, cMax];
}

/**
 * 将 OKHSL 转换为 sRGB 通道（范围为 0-255，四舍五入），并裁剪超出色域的通道。
 * @param hue 色相，单位为度。
 * @param saturation 饱和度，范围为 0-1。
 * @param lightness 亮度，范围为 0-1。
 */
export function okhslToRgb(hue: number, saturation: number, lightness: number): RgbColor {
	const L = okhslToOklabLightness(lightness);
	let lab: Vector = [L, 0, 0];
	if (L > 0 && L < 1 && saturation > 0) {
		const angle = (2 * Math.PI * (((hue % 360) + 360) % 360)) / 360;
		const a = Math.cos(angle);
		const b = Math.sin(angle);
		const [c0, cMid, cMax] = chromaStops(L, a, b);
		// 色度随饱和度增加：从 0 增至 s=0.8 时的 cMid，最后在 s=1 时达到 cMax。
		let chroma: number;
		if (saturation < 0.8) {
			const t = 1.25 * saturation;
			const k1 = 0.8 * c0;
			chroma = (t * k1) / (1 - (1 - k1 / cMid) * t);
		} else {
			const t = 5 * (saturation - 0.8);
			const k1 = (0.2 * cMid ** 2 * 1.25 ** 2) / c0;
			chroma = cMid + (t * k1) / (1 - (1 - k1 / (cMax - cMid)) * t);
		}
		lab = [L, chroma * a, chroma * b];
	}
	return linearSrgbToRgb(oklabToLinearSrgb(lab));
}

/**
 * 将 sRGB 通道（范围为 0-255）转换为 OKHSL。
 * @returns 色相 `h`（单位为度，灰色为 0）、饱和度 `s` 和亮度 `l`（范围均为 0-1）。
 */
export function rgbToOkhsl(rgb: RgbColor): { h: number; s: number; l: number } {
	const [L, labA, labB] = rgbToOklab(rgb);
	const chroma = Math.hypot(labA, labB);
	const lightness = oklabToOkhslLightness(L);
	if (chroma < 1e-9 || lightness <= 0 || lightness >= 1) return { h: 0, s: 0, l: lightness };

	const hue = ((Math.atan2(labB, labA) * 180) / Math.PI + 360) % 360;
	const [c0, cMid, cMax] = chromaStops(L, labA / chroma, labB / chroma);
	let saturation: number;
	if (chroma < cMid) {
		const k1 = 0.8 * c0;
		saturation = 0.8 * (chroma / (k1 + (1 - k1 / cMid) * chroma));
	} else {
		const k1 = (0.2 * cMid ** 2 * 1.25 ** 2) / c0;
		const offset = chroma - cMid;
		saturation = 0.8 + 0.2 * (offset / (k1 + (1 - k1 / (cMax - cMid)) * offset));
	}
	return { h: hue, s: Math.min(1, Math.max(0, saturation)), l: lightness };
}
