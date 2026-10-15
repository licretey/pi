import { type SpawnSyncReturns, spawnSync } from "child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { APP_NAME, getBinDir } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub 仓库（例如 "sharkdp/fd"）
	binaryName: string; // 压缩包内的二进制文件名
	systemBinaryNames?: string[]; // 下载前优先尝试的系统命令别名
	tagPrefix: string; // tag 前缀（例如 v1.0.0 用 "v"，1.0.0 用 ""）
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

// 通过尝试运行来检查某条命令是否存在于 PATH 中
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// 检查 ENOENT 错误（命令未找到）
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

// 获取工具路径（系统全局路径或我们的工具目录）
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// 先检查我们的工具目录
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// 检查系统 PATH——若找到，直接返回命令名（它已在 PATH 中）
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// 从 release 页面的重定向中解析最新的 release 版本。
// api.github.com 的 releases 端点会消耗匿名 API 配额（每 IP 每小时 60 次请求），
// 在公司代理、CI runner 等共享出口 IP 之后该配额早已耗尽。Web 端点以重定向到
// 带 tag 的 release 页作为响应，不消耗配额，且与二进制下载同属一个源站。
export async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetchWithRetry(
		`https://github.com/${repo}/releases/latest`,
		{
			headers: { "User-Agent": `${APP_NAME}-coding-agent` },
			redirect: "manual",
		},
		{ timeoutMs: NETWORK_TIMEOUT_MS },
	);

	// 这里只有状态码和响应头重要。丢弃响应体以便连接可以被复用。
	try {
		await response.body?.cancel();
	} catch {
		// 丢弃响应体是尽力而为的操作。
	}

	const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
	if (!location) {
		throw new Error(`Failed to resolve latest ${repo} release: HTTP ${response.status} without redirect`);
	}

	const tag = new URL(location, "https://github.com").pathname.split("/").pop();
	if (!tag || !location.includes("/releases/tag/")) {
		throw new Error(`Failed to resolve latest ${repo} release: unexpected redirect to ${location}`);
	}
	return decodeURIComponent(tag).replace(/^v/, "");
}

// 从 URL 下载文件
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });

	if (!response.ok) {
		throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	return `exit status ${result.status ?? "unknown"}`;
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	return "tar.exe";
}

function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows 自带的 bsdtar 就是 tar.exe，它支持 zip 文件。优先使用 System32
		// 中的二进制，而不是 Git Bash 的 GNU tar，后者不支持 zip 归档。
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

// 下载并安装工具
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// fd 在 darwin/x64 上被固定版本，因此在该平台跳过版本查询。
	const version =
		tool === "fd" && plat === "darwin" && architecture === "x64" ? "10.3.0" : await getLatestVersion(config.repo);

	// 获取该平台的资源文件名
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// 创建工具目录
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// 下载
	await downloadFile(downloadUrl, archivePath);

	// 解压到唯一的临时目录。启动阶段 fd 和 rg 的下载可能并发运行，
	// 共享一个固定目录会导致竞态。
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// 在解压出的文件中定位二进制。有些归档把文件直接放在根目录下，
		// 另一些则嵌套在带版本号的子目录中。
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// 赋予可执行权限（仅 Unix）
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// 清理
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// 各工具对应的 Termux 包名
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

/**
 * 确保某个工具可用，必要时进行下载。
 * 通过 `onStatus` 报告进度；除此之外状态消息保持静默。
 * 返回工具路径，不可用时返回 undefined。
 */
export async function ensureTool(
	tool: "fd" | "rg",
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		onStatus?.({ type: "warning", message: `${config.name} not found. Offline mode enabled, skipping download.` });
		return undefined;
	}

	// 在 Android/Termux 上，由于 Bionic libc 不兼容，Linux 二进制无法运行。
	// 用户必须通过 pkg 安装。
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });
		return undefined;
	}

	// 未找到工具——进行下载
	onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });

	try {
		const path = await downloadTool(tool);
		onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
		return path;
	} catch (e) {
		// 串起错误的 cause 链：fetch 失败会表现为一个仅带 "fetch failed" 的
		// TypeError，而可行动的细节（DNS、TLS、超时）藏在 cause 中。
		// 深度设上限以防循环的 cause 链。
		const messages: string[] = [];
		for (
			let current: unknown = e, depth = 0;
			current instanceof Error && depth < 5;
			current = current.cause, depth++
		) {
			if (!messages.includes(current.message)) messages.push(current.message);
		}
		onStatus?.({
			type: "warning",
			message: `Failed to download ${config.name}: ${messages.length > 0 ? messages.join(": ") : String(e)}`,
		});
		return undefined;
	}
}
