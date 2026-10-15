import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { spawnProcessSync } from "./utils/child-process.ts";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

// =============================================================================
// 包检测
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 检测当前是否以 Bun 编译的二进制运行。
 * Bun 二进制的 import.meta.url 会包含 "$bunfs"、"~BUN" 或 "%7EBUN"（Bun 的虚拟文件系统路径）
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** 检测 Bun 是否为运行时（编译出的二进制或 bun run）。 */
export const isBunRuntime = !!process.versions.bun;

/** 检测 esbuild 打包的 Node.js 发行版。 */
declare const PI_BUNDLED_NODE: boolean;
export const isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE;

// =============================================================================
// 安装方式检测
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

export type SelfUpdatePackageTarget = string | { packageName: string; installSpec?: string };

function normalizeSelfUpdatePackageTarget(target: SelfUpdatePackageTarget): {
	packageName: string;
	installSpec: string;
} {
	if (typeof target === "string") {
		return { packageName: target, installSpec: target };
	}
	return { packageName: target.packageName, installSpec: target.installSpec ?? target.packageName };
}

function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const packageDir = getPackageDir();
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		root = parent;
	}
	if (!root) return undefined;
	const rootParent = path.dirname(root);
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows 全局 npm 前缀采用 `<prefix>\\node_modules`，仅凭路径形状无法与本地项目
	// 安装区分开。在没有 `npm root -g` 佐证时，不要推断不支持的 Windows 自定义前缀。
	return undefined;
}

function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updatePackageTarget: SelfUpdatePackageTarget = installedPackageName,
	npmCommand?: string[],
): SelfUpdateCommand | undefined {
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	switch (method) {
		case "bun-binary":
			return undefined;
		case "pnpm": {
			const match = readCommandOutput("pnpm", ["root", "-g"])
				? undefined
				: /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getPackageDir());
			const binDirArgs = match
				? [`--config.global-bin-dir=${process.env.PNPM_HOME || dirname(dirname(match[1]))}`]
				: [];
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", [
					"install",
					"-g",
					"--ignore-scripts",
					"--config.minimumReleaseAge=0",
					...binDirArgs,
					target.installSpec,
				]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", ...binDirArgs, installedPackageName]),
			);
		}
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", target.installSpec]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", [
					"install",
					"-g",
					"--ignore-scripts",
					"--minimum-release-age=0",
					target.installSpec,
				]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
			);
		case "npm": {
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			// pi.dev 会立即发布 releases，配置了 npm age gate 反而会阻塞更新。npm 没有按包的
			// age gate，所以这也让新的传递依赖 release 得以通过。托管安装（managed installs）不受影响。
			const installStep = makeSelfUpdateCommandStep(command, [
				...prefixArgs,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				target.installSpec,
			]);
			const uninstallStep =
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep);
		}
		case "unknown":
			return undefined;
	}
}

function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnProcessSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			if (root) return [root, dirname(root)];
			const match = /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getPackageDir());
			return match ? [match[1]] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "unknown":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string, resolveSymlinks: boolean): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath = resolvedPath;
	if (resolveSymlinks) {
		try {
			normalizedPath = realpathSync(resolvedPath);
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function getPathComparisonCandidates(path: string): string[] {
	return Array.from(
		new Set(
			[normalizeExistingPathForComparison(path, false), normalizeExistingPathForComparison(path, true)].filter(
				(candidate): candidate is string => !!candidate,
			),
		),
	);
}

function getEntrypointPackageDir(): string | undefined {
	const entrypoint = process.argv[1];
	if (!entrypoint) return undefined;
	let dir = dirname(entrypoint);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return undefined;
}

function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDirs = [getPackageDir(), getEntrypointPackageDir()].filter((dir): dir is string => !!dir);
	const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
	return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
		return getPathComparisonCandidates(root).some((normalizedRoot) => {
			const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
			return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
		});
	});
}

export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageTarget, npmCommand);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
): string {
	const method = detectInstallMethod();
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	if (method === "bun-binary") {
		return `Download from: https://github.com/earendil-works/pi/releases/latest`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, target, npmCommand);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${target.installSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// 随可执行文件一起发布的包资源路径
// =============================================================================

/**
 * 获取解析包资源（themes、package.json、README.md、CHANGELOG.md）的基础目录。
 * - Bun 二进制：返回可执行文件所在目录
 * - Node.js：返回包含 package.json 的包根目录
 * - 当包根目录可用时，忽略被复制进 dist/ 的 Bun 二进制元数据
 */
export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const parent = dirname(dir);
			// build:binary 会把 Bun 的元数据放进 dist/。Node 仍然需要包根目录，
			// 否则它相对 dist 的资源路径会变成 dist/dist/。
			if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
				return parent;
			}
			return dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

export function getPackageDir(): string {
	// 允许通过环境变量覆盖（在 Nix/Guix 上很有用，因为 store 路径中的分词很差）
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Bun 二进制：process.execPath 指向编译出的可执行文件
		return dirname(process.execPath);
	}
	return findNodePackageDir(__dirname);
}

/**
 * 获取内置主题目录的路径（随包发布）
 * - Bun 二进制：可执行文件旁的 theme/
 * - Node.js（dist/）：dist/modes/interactive/theme/
 * - 源码（src/）：src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// 主题位于相对 src/ 或 dist/ 的 modes/interactive/theme/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * 获取 HTML 导出模板目录的路径（随包发布）
 * - Bun 二进制：可执行文件旁的 export-html/
 * - Node.js（dist/）：dist/core/export-html/
 * - 源码（src/）：src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** 获取 package.json 的路径 */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** 获取 README.md 的路径 */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** 获取 docs 目录的路径 */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** 获取 examples 目录的路径 */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** 获取 CHANGELOG.md 的路径 */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * 获取内置交互式资源目录的路径。
 * - Bun 二进制：可执行文件旁的 assets/
 * - Node.js（dist/）：dist/modes/interactive/assets/
 * - 源码（src/）：src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** 获取一个打包的交互式资源的路径 */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

let quickJSWasmPath: string | undefined;

/** 由 Bun 入口调用，传入编译进可执行文件的 QuickJS wasm 文件路径。 */
export function setEmbeddedQuickJSWasmPath(path: string): void {
	quickJSWasmPath = path;
}

/**
 * 获取 `quickjs-wasi/quickjs.wasm` 的路径——即运行 codemode 脚本的 VM。只解析一次，
 * 这样即使某次更新移除了当前安装，按路径缓存的编译模块也能继续工作（#10439）。
 */
export function getQuickJSWasmPath(): string {
	quickJSWasmPath ??= createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
	return quickJSWasmPath;
}

/** 为 release 运行时解析 codemode worker 入口。 */
export function resolveCodemodeWorkerSpecifier(
	runtime: "bun-binary" | "bundled-node" | "unbundled",
	moduleUrl: string,
): string | URL | undefined {
	// Bun 内嵌了显式的源码入口，但 Windows 上的 Bun 1.3 无法把绝对的
	// B:\~BUN URL 映射回其中之一。带原始源码扩展名的相对字符串在所有
	// Bun 平台上都有效。
	if (runtime === "bun-binary") return "./src/extensions/codemode/worker.ts";
	if (runtime === "bundled-node") return new URL("./codemode-worker.js", moduleUrl);
	return undefined;
}

let codemodeWorkerDataUrl: URL | undefined;

/**
 * 获取 codemode worker 入口；返回 undefined 表示使用 pi-codemode 旁边自带的 worker。
 * Bun 与 Node 的 release 构建都会把 worker 作为额外入口传入。
 */
export function getCodemodeWorkerSpecifier(): string | URL | undefined {
	const runtime = isBunBinary ? "bun-binary" : isBundledNode ? "bundled-node" : "unbundled";
	const specifier = resolveCodemodeWorkerSpecifier(runtime, import.meta.url);
	if (runtime !== "bundled-node" || !(specifier instanceof URL)) return specifier;
	// 从内存副本 spawn worker。一次更新会在本进程仍在运行时替换或删除该文件（#10439）。
	// bundle 构建保持 worker 不含相对导入和 import.meta，因此它能从 data: URL 运行。
	codemodeWorkerDataUrl ??= new URL(`data:text/javascript;base64,${readFileSync(specifier).toString("base64")}`);
	return codemodeWorkerDataUrl;
}

export type InstallChange = { kind: "updated"; version: string } | { kind: "removed" };

/**
 * 检测当前进程运行的包是否在磁盘上发生了变化，例如在另一个终端执行了 `pi update` 之后。
 * 按需加载的代码届时可能缺失，或来自另一个版本。
 *
 * 检查启动时读取的 package.json。重新解析它会向上越过已被删除的安装目录，
 * 进而可能找到一个无关的 package.json，例如主目录里的那个。
 */
export function detectInstallChange(packageJsonPath = startupPackageJsonPath): InstallChange | undefined {
	// Bun 二进制内嵌了自己的代码，替换可执行文件不会影响本进程。
	if (isBunBinary || !packageJsonPath) return undefined;
	let installed: PackageJson;
	try {
		installed = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "removed" } : undefined;
	}
	return installed.version && installed.version !== VERSION
		? { kind: "updated", version: installed.version }
		: undefined;
}

// =============================================================================
// 应用配置（来自 package.json 的 piConfig）
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
/** 本进程启动时所在的 package.json（如果存在）。 */
let startupPackageJsonPath: string | undefined;
try {
	const packageJsonPath = getPackageJsonPath();
	pkg = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
	startupPackageJsonPath = packageJsonPath;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const piConfigName: string | undefined = pkg.piConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
export const VERSION: string = pkg.version || "0.0.0";

// 例如 PI_CODING_AGENT_DIR 或 TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** 获取某个 gist ID 的分享查看器 URL。 */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// 用户配置路径（~/.pi/agent/*）
// =============================================================================

/** 获取 agent 配置目录（例如 ~/.pi/agent/） */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** 获取用户自定义主题目录的路径 */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** 获取 models.json 的路径 */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** 获取 auth.json 的路径 */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** 获取 settings.json 的路径 */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** 获取 tools 目录的路径 */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** 获取托管二进制目录（fd、rg）的路径 */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** 获取 prompt 模板目录的路径 */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** 获取 sessions 目录的路径 */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** 获取调试日志文件的路径 */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
