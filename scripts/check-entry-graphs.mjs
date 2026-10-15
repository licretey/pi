#!/usr/bin/env node
/**
 * 入口点定义了模块加载成本。
 *
 * 包的 `exports` 映射是唯一明确声明公共模块的位置。一个意外的 `export *` 就可能让原本精简的入口
 * 引入整个 barrel：通过 barrel 导入一个仅有单个文件的纯函数，可能导致约 37 MB 的模块依赖图被求值；
 * 如果不实际测量进程，这类问题不会自动暴露。此脚本遍历所有已声明入口点的值导入依赖图，
 * 并为每个入口设置预算，使此类回归能在提交时被发现。
 *
 * 只统计值导入。`import type` 和 `export type` 会在 Node 运行前被擦除。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 工作区软件包名称到源码根目录的映射，用于继续追踪跨包导入。 */
const WORKSPACE = {
	"@earendil-works/chord": "packages/chord/src",
	"@earendil-works/pi-ai": "packages/ai/src",
	"@earendil-works/pi-durable": "packages/durable/src",
	"@earendil-works/pi-agent-core": "packages/agent/src",
	"@earendil-works/pi-codemode": "packages/codemode/src",
	"@earendil-works/pi-telemetry": "packages/telemetry/src",
	"@earendil-works/pi-mcp": "packages/mcp/src",
	"@earendil-works/pi-tui": "packages/tui/src",
};

/**
 * 预算经过有意设置。未列出预算的入口不受限制；每个列出的入口都声明了允许触达的依赖图范围。
 */
const BUDGETS = {
	"packages/ai": {
		"./models": {
			maxFiles: 15,
			forbid: ["providers/", "models.generated.ts", "index.ts", "utils/validation.ts", "utils/typebox-helpers.ts"],
		},
		"./utils/*": { maxFiles: 3, forbid: ["providers/", "api/", "index.ts"] },
	},
	"packages/durable": {
		".": {
			// 工具参数校验会引入 TypeBox；提供商会话创建会引入 pi-ai 的轻量 UUID 工具；
			// 内存存储和 SQLite 存储共享扫描顺序与游标处理逻辑。
			maxFiles: 63,
			forbid: [
				"packages/ai/src/index.ts",
				"packages/ai/src/utils/typebox-helpers.ts",
				// Photon（WebAssembly）只会通过 `./images` 加载。
				"packages/durable/src/images/",
			],
		},
		// 文件工具只会引入所需的环境辅助函数和 Harness 定义，不会引入 Harness 本身。
		"./tools": { maxFiles: 17, forbid: ["packages/durable/src/images/"] },
	},
};

const SPEC = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?\sfrom\s*)?["']([^"']+)["']/g;

function resolveSpec(spec, fromFile) {
	if (spec.startsWith("node:")) return null;
	if (spec.startsWith(".")) {
		const base = resolve(dirname(fromFile), spec);
		for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
		return null;
	}
	for (const [name, src] of Object.entries(WORKSPACE)) {
		if (spec === name) return resolve(ROOT, src, "index.ts");
		if (!spec.startsWith(`${name}/`)) continue;
		const tail = spec.slice(name.length + 1);
		for (const candidate of [`${tail}.ts`, `${tail}/index.ts`, tail]) {
			const file = resolve(ROOT, src, candidate);
			if (existsSync(file) && statSync(file).isFile()) return file;
		}
	}
	return null; // 外部依赖，不属于工作区依赖图。
}

function walk(entryFile) {
	const seen = new Set();
	const queue = [entryFile];
	while (queue.length > 0) {
		const file = queue.pop();
		if (seen.has(file) || file.endsWith(".json")) continue;
		seen.add(file);
		for (const match of readFileSync(file, "utf8").matchAll(SPEC)) {
			const target = resolveSpec(match[2], file);
			if (target) queue.push(target);
		}
	}
	return seen;
}

/** exports 映射中的 `./dist/harness/context.js` 对应磁盘上的 `src/harness/context.ts`。 */
function sourceFor(pkgDir, distPath) {
	const rel = distPath.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts");
	const file = resolve(ROOT, pkgDir, "src", rel);
	return existsSync(file) ? file : undefined;
}

function expand(pkgDir, entry, target) {
	if (!entry.includes("*")) return [[entry, target]];
	const dir = resolve(ROOT, pkgDir, "src", dirname(target.replace(/^\.\/dist\//, "")));
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => [entry.replace("*", name.replace(/\.ts$/, "")), target.replace("*", name.replace(/\.ts$/, ""))]);
}

let failures = 0;
for (const [pkgDir, budgets] of Object.entries(BUDGETS)) {
	const manifest = JSON.parse(readFileSync(resolve(ROOT, pkgDir, "package.json"), "utf8"));
	for (const [entry, budget] of Object.entries(budgets)) {
		const declared = manifest.exports?.[entry];
		if (!declared) {
			console.error(`${pkgDir} declares no export "${entry}" but a budget exists for it`);
			failures += 1;
			continue;
		}
		const target = typeof declared === "string" ? declared : declared.import;
		for (const [name, distPath] of expand(pkgDir, entry, target)) {
			const source = sourceFor(pkgDir, distPath);
			if (!source) {
				console.error(`${pkgDir} export "${name}" points at ${distPath}, which has no source file`);
				failures += 1;
				continue;
			}
			const graph = [...walk(source)].map((file) => relative(ROOT, file));
			if (graph.length > budget.maxFiles) {
				console.error(
					`${pkgDir} export "${name}" reaches ${graph.length} files, budget ${budget.maxFiles}\n` +
						graph.map((file) => `    ${file}`).join("\n"),
				);
				failures += 1;
			}
			for (const pattern of budget.forbid ?? []) {
				const hit = graph.filter((file) => file.includes(pattern));
				if (hit.length > 0) {
					console.error(`${pkgDir} export "${name}" must not reach ${pattern}:\n${hit.map((f) => `    ${f}`).join("\n")}`);
					failures += 1;
				}
			}
		}
	}
}

if (failures > 0) {
	console.error(`\n${failures} entry-point budget violation(s).`);
	process.exit(1);
}
console.log("Entry point graphs are within budget.");
