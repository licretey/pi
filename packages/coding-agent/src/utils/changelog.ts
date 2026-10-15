import path from "node:path";
import { existsSync, readFileSync } from "fs";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

const GITHUB_REPO = "earendil-works/pi";
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

function entryVersion(entry: ChangelogEntry): string {
	return `${entry.major}.${entry.minor}.${entry.patch}`;
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeChangelogLinkTarget(target: string, tag: string): string {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${GITHUB_REPO}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${GITHUB_REPO}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	const tag = normalizeTag(version);
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
}

/**
 * 解析 CHANGELOG.md 中的变更日志条目。
 * 扫描以 ## 开头的行，并收集其后直到下一个 ## 标题或文件末尾的内容。
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number } | null = null;

		for (const line of lines) {
			// 检查此行是否为版本标题（## [x.y.z] ...）。
			if (line.startsWith("## ")) {
				// 如果存在上一条记录，则保存。
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// 尝试从此行解析版本号。
				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
					};
					currentLines = [line];
				} else {
					// 无法解析版本号时重置状态。
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// 收集当前版本的内容行。
				currentLines.push(line);
			}
		}

		// 保存最后一条记录。
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * 比较版本号。返回值：v1 < v2 时为 -1，v1 === v2 时为 0，v1 > v2 时为 1。
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * 获取晚于 lastVersion 的条目。
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	// 解析 lastVersion。
	const parts = lastVersion.split(".").map(Number);
	const last: ChangelogEntry = {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// 为方便使用，从 paths.ts 重新导出 getChangelogPath。
export { getChangelogPath } from "../config.ts";
