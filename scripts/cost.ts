#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";

// 解析命令行参数。
const args = process.argv.slice(2);
let directory: string | undefined;
let days: number | undefined;

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--dir" || args[i] === "-d") {
		directory = args[++i];
	} else if (args[i] === "--days" || args[i] === "-n") {
		days = parseInt(args[++i], 10);
	} else if (args[i] === "--help" || args[i] === "-h") {
		console.log(`Usage: cost.ts -d <path> -n <days>
  -d, --dir <path>   Directory path (required)
  -n, --days <num>   Number of days to track (required)
  -h, --help         Show this help`);
		process.exit(0);
	}
}

if (!directory || !days) {
	console.error("Error: both --dir and --days are required");
	console.error("Run with --help for usage");
	process.exit(1);
}

// 将目录路径编码为会话文件夹名称。
function encodeSessionDir(dir: string): string {
	// 去掉开头的斜杠，并将其余斜杠替换为连字符。
	const normalized = dir.startsWith("/") ? dir.slice(1) : dir;
	return "--" + normalized.replace(/\//g, "-") + "--";
}

const sessionsBase = path.join(process.env.HOME!, ".pi/agent/sessions");
const encodedDir = encodeSessionDir(directory);
const sessionsDir = path.join(sessionsBase, encodedDir);

if (!fs.existsSync(sessionsDir)) {
	console.error(`Sessions directory not found: ${sessionsDir}`);
	process.exit(1);
}

// 计算统计的起始日期。
const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - days);
cutoff.setHours(0, 0, 0, 0);

interface DayCost {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	requests: number;
}

interface Stats {
	[day: string]: {
		[provider: string]: DayCost;
	};
}

const stats: Stats = {};

// 处理会话文件。
const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));

for (const file of files) {
	// 从文件名中提取时间戳：<timestamp>_<uuid>.jsonl
	// 格式为 2025-12-17T08-25-07-381Z（用连字符替代冒号）。
	const timestamp = file.split("_")[0];
	// 转换回有效的 ISO 格式：将 T08-25-07-381Z 替换为 T08:25:07.381Z。
	const isoTimestamp = timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z");
	const fileDate = new Date(isoTimestamp);

	if (fileDate < cutoff) continue;

	const filepath = path.join(sessionsDir, file);
	const content = fs.readFileSync(filepath, "utf8");
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line) continue;

		try {
			const entry = JSON.parse(line);

			if (entry.type !== "message") continue;
			if (entry.message?.role !== "assistant") continue;
			if (!entry.message?.usage?.cost) continue;

			const { provider, usage } = entry.message;
			const { cost } = usage;
			const entryDate = new Date(entry.timestamp);
			const day = entryDate.toISOString().split("T")[0];

			if (!stats[day]) stats[day] = {};
			if (!stats[day][provider]) {
				stats[day][provider] = {
					total: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					requests: 0,
				};
			}

			stats[day][provider].total += cost.total || 0;
			stats[day][provider].input += cost.input || 0;
			stats[day][provider].output += cost.output || 0;
			stats[day][provider].cacheRead += cost.cacheRead || 0;
			stats[day][provider].cacheWrite += cost.cacheWrite || 0;
			stats[day][provider].requests += 1;
		} catch {
			// 跳过格式错误的行。
		}
	}
}

// 按日期排序并输出。
const sortedDays = Object.keys(stats).sort();

if (sortedDays.length === 0) {
	console.log(`No sessions found in the last ${days} days for: ${directory}`);
	process.exit(0);
}

console.log(`\nCost breakdown for: ${directory}`);
console.log(`Period: last ${days} days (since ${cutoff.toISOString().split("T")[0]})`);
console.log("=".repeat(80));

let grandTotal = 0;
const providerTotals: { [p: string]: DayCost } = {};

for (const day of sortedDays) {
	console.log(`\n${day}`);
	console.log("-".repeat(40));

	let dayTotal = 0;
	const providers = Object.keys(stats[day]).sort();

	for (const provider of providers) {
		const s = stats[day][provider];
		dayTotal += s.total;

		if (!providerTotals[provider]) {
			providerTotals[provider] = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
		}
		providerTotals[provider].total += s.total;
		providerTotals[provider].input += s.input;
		providerTotals[provider].output += s.output;
		providerTotals[provider].cacheRead += s.cacheRead;
		providerTotals[provider].cacheWrite += s.cacheWrite;
		providerTotals[provider].requests += s.requests;

		console.log(
			`  ${provider.padEnd(15)} $${s.total.toFixed(4).padStart(8)}  (${s.requests} reqs, in: $${s.input.toFixed(4)}, out: $${s.output.toFixed(4)}, cache: $${(s.cacheRead + s.cacheWrite).toFixed(4)})`
		);
	}

	console.log(`  ${"Day total:".padEnd(15)} $${dayTotal.toFixed(4).padStart(8)}`);
	grandTotal += dayTotal;
}

console.log("\n" + "=".repeat(80));
console.log("TOTALS BY PROVIDER");
console.log("-".repeat(40));

for (const provider of Object.keys(providerTotals).sort()) {
	const t = providerTotals[provider];
	console.log(
		`  ${provider.padEnd(15)} $${t.total.toFixed(4).padStart(8)}  (${t.requests} reqs, in: $${t.input.toFixed(4)}, out: $${t.output.toFixed(4)}, cache: $${(t.cacheRead + t.cacheWrite).toFixed(4)})`
	);
}

console.log("-".repeat(40));
console.log(`  ${"GRAND TOTAL:".padEnd(15)} $${grandTotal.toFixed(4).padStart(8)}`);
console.log();
