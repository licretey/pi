#!/usr/bin/env node
/**
 * pi-mono 发布脚本。
 *
 * 用法：
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * 步骤：
 * 1. 检查是否存在未提交的更改。
 * 2. 确认所有公开工作区包均已发布到 npm；若 Nix 模型目录固定版本已过期，则更新它。
 * 3. 通过 npm run version:xxx 升级版本，或设置明确的版本号。
 * 4. 更新 CHANGELOG.md 文件：将 [Unreleased] 改为 [版本号] - 日期。
 * 5. 重新生成发布产物。
 * 6. 运行检查和测试。
 * 7. 提交并为本次发布创建标签。
 * 8. 在变更日志中添加新的 [Unreleased] 区段。
 * 9. 提交下一周期的变更日志更新。
 * 10. 推送 main 分支和标签，触发 CI 发布及 pi.dev 的验证公告。
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function assertPackagesAreRegisteredWithNpm() {
	const packageNames = getPublicWorkspacePackages().map((pkg) => pkg.name);
	const unregisteredPackages = [];

	console.log("Checking npm package registration...");
	for (const packageName of packageNames) {
		const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["view", packageName, "version", "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (result.status === 0 && result.stdout.trim()) {
			console.log(`  ${packageName}`);
			continue;
		}

		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		if (output.includes("E404") || output.includes("404 Not Found")) {
			unregisteredPackages.push(packageName);
			continue;
		}

		throw new Error(output ? `Failed to query npm registration for ${packageName}\n${output}` : `Failed to query npm registration for ${packageName}`);
	}

	if (unregisteredPackages.length > 0) {
		throw new Error(`The following public workspace packages are not registered on npm:\n${unregisteredPackages.map((packageName) => `  ${packageName}`).join("\n")}\nRegister them before running a release.`);
	}

	console.log("  All public workspace packages are registered on npm\n");
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function removeStaleWorkspaceLockEntries() {
	const workspaceVersions = new Map(
		getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]),
	);
	const lockPath = "package-lock.json";
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	let removed = 0;

	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path.startsWith("packages/") || pkg.link === true) {
			continue;
		}
		for (const [name, version] of workspaceVersions) {
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}

	if (removed > 0) {
		writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
		console.log(`Removed ${removed} stale workspace package lock ${removed === 1 ? "entry" : "entries"}.`);
	}
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
	} else {
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
			process.exit(1);
		}

		console.log(`Setting explicit version (${target})...`);
		run(`npm version ${target} --workspaces --no-git-tag-version --no-workspaces-update && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`);
	}

	// sync-versions 更新包间依赖范围之前，npm version 可能会暂时安装旧版工作区包。
	// 删除锁文件中的过期条目，刷新锁文件，然后根据最终依赖关系图安装依赖。
	removeStaleWorkspaceLockEntries();
	run("npm install --package-lock-only --ignore-scripts");
	run("npm ci --ignore-scripts");
	return getVersion();
}

function getChangelogs() {
	return findPackageDirectories()
		.map((directory) => join(directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// 在 "# Changelog\n\n" 之后插入。
		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// 主流程。
console.log("\n=== Release Script ===\n");

// 1. 检查是否存在未提交的更改。
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. 修改工作区之前，确认 npm 软件包均已注册。
assertPackagesAreRegisteredWithNpm();

// 发布标签不可变，因此带标签的 Nix 固定版本必须能够构建该发行版。
// 在升级版本前刷新固定版本，此时 pi.dev 仍识别当前版本，这样更新会包含在发布提交中。
console.log("Refreshing the Nix model catalog pin if stale...");
run("node scripts/update-model-catalog-pin.mjs --if-stale");
console.log();

// 3. 升级版本或设置指定版本。
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 4. 更新变更日志。
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 5. 重新生成发布产物。
console.log("Regenerating release artifacts...");
run("npm run generate:models");
run("npm run check:model-data");
run("npm run install-lock:coding-agent");
console.log();

// 6. 运行检查和测试。
console.log("Running checks...");
run("npm run check");
console.log();

console.log("Building packages for tests...");
run("npm run build:offline");
console.log();

// 设置 PI_RELEASE_SKIP_TESTS=1 可跳过测试套件，例如测试已通过 `npm run release:local`，
// 但机器负载过高导致对时序敏感的测试失败时。常规检查和安装检查仍会运行。
if (process.env.PI_RELEASE_SKIP_TESTS === "1") {
	console.log("Skipping tests (PI_RELEASE_SKIP_TESTS=1)\n");
} else {
	console.log("Running tests...");
	run("./test.sh");
	console.log();
}

console.log("Checking the packed coding-agent consumer install...");
run("npm run check:package-install");
console.log();

// 7. 提交更改并创建标签。
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

// 8. 添加新的 [Unreleased] 区段。
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 9. 提交变更日志更新。
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 10. 推送到远程仓库。
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Prepared release v${version}; CI publication and pi.dev announcement start after the tag push ===`);
