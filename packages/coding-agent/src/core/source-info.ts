import type { PathMetadata } from "./package-manager.ts";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
}

/** 内置工具和扩展路径的前缀，例如 `builtin:read` 或 `builtin:mcp`。 */
export const BUILTIN_PATH_PREFIX = "builtin:";

/**
 * 不对应文件的路径来源：`builtin:<name>` 对应 `builtin`；尖括号路径（如 `<inline:name>`）则对应其中的前缀，
 * 此例为 `inline`。文件路径返回 undefined。
 */
export function getSyntheticPathSource(path: string): string | undefined {
	if (path.startsWith(BUILTIN_PATH_PREFIX)) return "builtin";
	if (path.startsWith("<") && path.endsWith(">")) return path.slice(1, -1).split(":")[0] || "temporary";
	return undefined;
}

export function isSyntheticPath(path: string): boolean {
	return path.startsWith(BUILTIN_PATH_PREFIX) || path.startsWith("<");
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
	};
}
