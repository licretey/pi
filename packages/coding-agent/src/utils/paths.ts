import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "./child-process.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface PathInputOptions {
	/** 规范化前去除首尾空白。 */
	trim?: boolean;
	/** 将开头的 `~` 展开为主目录。默认为 true。 */
	expandTilde?: boolean;
	/** 展开 `~` 时使用的主目录。默认为 `os.homedir()`。 */
	homeDir?: string;
	/** 去除开头的 `@`，用于命令行 @file 路径。 */
	stripAtPrefix?: boolean;
	/** 将各种 Unicode 空格规范为普通空格。 */
	normalizeUnicodeSpaces?: boolean;
}

/**
 * 跟随符号链接，将路径解析为规范（真实）路径。
 * 如果解析失败（例如目标尚不存在），则回退到原始路径，
 * 这样调用方不会因为文件系统条目缺失而崩溃。

 */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function getFileRevision(path: string): string | undefined {
	try {
		const stats = statSync(path, { bigint: true });
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	} catch {
		return undefined;
	}
}

/**
 * 如果值不是包来源（npm:、git: 等）、
 * 内置扩展（builtin:）或远程 URL 协议，则返回 true。裸名称、
 * 相对路径和 file: URL 均视为本地路径。
 */
export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	// 已知的非本地前缀。file: URL 属于本地路径，因此会由 resolvePath() 解析。
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:") ||
		trimmed.startsWith("builtin:")
	) {
		return false;
	}
	return true;
}

/** 将 Git Bash、MSYS、Cygwin 和 WSL 的盘符路径转换为 Windows 原生 API 可接受的格式。 */
export function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (process.platform === "win32") {
		normalized = normalizeWindowsShellPath(normalized);
	}

	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		if (normalized === "~") return home;
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return join(home, normalized.slice(2));
		}
	}

	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}

	return normalized;
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const relativePath = relative(resolvedCwd, resolvedPath);
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

	return isInsideCwd ? relativePath || "." : undefined;
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolvePath(filePath, cwd);
	return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

export function markPathIgnoredByCloudSync(path: string): void {
	const attrs =
		process.platform === "darwin"
			? ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
			: process.platform === "linux"
				? ["user.com.dropbox.ignored"]
				: [];

	for (const attr of attrs) {
		if (process.platform === "darwin") {
			spawnProcessSync("xattr", ["-w", attr, "1", path], { encoding: "utf-8", stdio: "ignore" });
		} else {
			spawnProcessSync("setfattr", ["-n", attr, "-v", "1", path], { encoding: "utf-8", stdio: "ignore" });
		}
	}
}
