#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hydrateModelCatalog } from "../packages/ai/scripts/hydrate-model-catalog.ts";
import { readModelDataProviderIds } from "../packages/ai/scripts/model-data.ts";

// 请求带类型信息的目录；修订版本哈希基于其字节内容计算。
const MODEL_TYPES = "types=chat,image,classifier";
const REVISION_RE = /^sha256-[0-9a-f]{64}$/;

function sha256(bytes) {
	return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fetchRevision(revision) {
	const response = await fetch(`https://pi.dev/api/models/revisions/${revision}?${MODEL_TYPES}`);
	if (!response.ok) throw new Error(`Catalog revision ${revision} is unavailable: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (sha256(bytes) !== revision) throw new Error(`Catalog revision ${revision} does not match its content`);
	return bytes;
}

async function fetchLiveCatalog(root) {
	const { version } = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));
	const response = await fetch(`https://pi.dev/api/models?pi-version=${encodeURIComponent(version)}&${MODEL_TYPES}`);
	if (!response.ok) throw new Error(`Catalog discovery failed: HTTP ${response.status}`);
	const revision = response.headers.get("x-pi-model-catalog-revision");
	if (typeof revision !== "string" || !REVISION_RE.test(revision)) {
		throw new Error("Catalog discovery returned an invalid or missing revision");
	}
	if (sha256(Buffer.from(await response.arrayBuffer())) !== revision) {
		throw new Error("Catalog discovery body does not match its revision");
	}
	return revision;
}

/**
 * 返回该目录为当前检出版本中的提供商提供的 `provider/type` 模型分组。
 * 生成的 `*.models.ts` 类型由这些数据推导，因此只有目录中包含对应提供商和模型类型的数据时，
 * 使用该分组的代码（例如 OPENCODE_CLASSIFIER_MODELS）才能通过类型检查。
 */
function modelTypeGroups(root, bytes) {
	const catalog = JSON.parse(bytes.toString("utf8"));
	const groups = new Set();
	for (const provider of readModelDataProviderIds(join(root, "packages/ai"))) {
		for (const model of catalog[provider] ?? []) groups.add(`${provider}/${model.type}`);
	}
	return groups;
}

/** 返回目录无法为当前检出版本完成数据水合的原因；如果可以水合，则返回 undefined。 */
function hydrationProblem(root, bytes) {
	const directory = mkdtempSync(join(tmpdir(), "pi-model-catalog-pin-"));
	try {
		const catalogPath = join(directory, "models.all.json");
		writeFileSync(catalogPath, bytes);
		hydrateModelCatalog(join(root, "packages/ai"), catalogPath, { validateOnly: true });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/**
 * 为 Nix 构建固定在线模型目录的版本。设置 `ifStale` 后，只要当前固定版本仍能为此检出版本完成数据水合，
 * 且包含在线目录为此检出版本的各提供商提供的全部模型类型，就继续保留当前固定版本。
 */
export async function updateModelCatalogPin(root, { ifStale = false } = {}) {
	const pinPath = join(root, "nix/model-catalog.json");
	const current = JSON.parse(readFileSync(pinPath, "utf8")).revision;
	let currentBytes;
	if (ifStale) {
		if (typeof current !== "string" || !REVISION_RE.test(current)) throw new Error(`Invalid pin in ${pinPath}`);
		currentBytes = await fetchRevision(current);
		const problem = hydrationProblem(root, currentBytes);
		if (problem) {
			console.error(`Pinned model catalog is stale: ${problem}`);
			currentBytes = undefined;
		}
	}

	const revision = await fetchLiveCatalog(root);
	// 只有不可变 URL 返回的目录能用于当前检出版本的构建时，才记录该固定版本。
	const bytes = await fetchRevision(revision);
	if (currentBytes) {
		// 在线目录由主分支生成。主分支代码可能使用当前固定版本缺少的模型类型，
		// 例如某个提供商新增分类模型之后。
		const pinned = modelTypeGroups(root, currentBytes);
		const missing = [...modelTypeGroups(root, bytes)].filter((group) => !pinned.has(group));
		if (missing.length === 0) return { revision: current, updated: false };
		console.error(`Pinned model catalog is stale: missing model types ${missing.sort().join(", ")}`);
	}
	const problem = hydrationProblem(root, bytes);
	if (problem) throw new Error(`Live model catalog ${revision} cannot hydrate this checkout: ${problem}`);
	writeFileSync(pinPath, `${JSON.stringify({ revision }, null, 2)}\n`);
	return { revision, updated: revision !== current };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	if (args.length > 1 || (args.length === 1 && args[0] !== "--if-stale")) {
		throw new Error("Usage: node scripts/update-model-catalog-pin.mjs [--if-stale]");
	}
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const { revision, updated } = await updateModelCatalogPin(root, { ifStale: args[0] === "--if-stale" });
	console.log(`${updated ? "Pinned" : "Kept"} model catalog ${revision}`);
}
