#!/usr/bin/env node

import { createCanvas } from "canvas";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 创建 200x200 画布。
const canvas = createCanvas(200, 200);
const ctx = canvas.getContext("2d");

// 将背景填充为白色。
ctx.fillStyle = "white";
ctx.fillRect(0, 0, 200, 200);

// 在画布中央绘制红色圆形。
ctx.fillStyle = "red";
ctx.beginPath();
ctx.arc(100, 100, 50, 0, Math.PI * 2);
ctx.fill();

// 保存图像。
const buffer = canvas.toBuffer("image/png");
const outputPath = join(__dirname, "..", "test", "data", "red-circle.png");

// 确保目标目录已存在。
mkdirSync(join(__dirname, "..", "test", "data"), { recursive: true });

writeFileSync(outputPath, buffer);
console.log(`Generated test image at: ${outputPath}`);
