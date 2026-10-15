import hostedGitInfo from "hosted-git-info";

/**
 * 解析后的 Git URL 信息。
 */
export type GitSource = {
	/** Git 来源的类型始终为 "git"。 */
	type: "git";
	/** 克隆 URL（始终可用于 git clone，且不含引用后缀）。 */
	repo: string;
	/** Git 主机域名（例如 "github.com"）。 */
	host: string;
	/** 仓库路径（例如 "user/repo"）。 */
	path: string;
	/** 指定时表示 Git 引用（分支、标签或提交）。 */
	ref?: string;
	/** 是否指定了引用（若为 true，则不会自动更新此包）。 */
	pinned: boolean;
};

function splitRef(url: string): { repo: string; ref?: string } {
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };
		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const refSeparator = pathWithMaybeRef.indexOf("@");
			if (refSeparator < 0) return { repo: url };
			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			if (!repoPath || !ref) return { repo: url };
			parsed.pathname = `/${repoPath}`;
			return {
				repo: parsed.toString().replace(/\/$/, ""),
				ref,
			};
		} catch {
			return { repo: url };
		}
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) {
		return { repo: url };
	}
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) {
		return { repo: url };
	}
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) {
		return { repo: url };
	}
	return {
		repo: `${host}/${repoPath}`,
		ref,
	};
}

function decodeForValidation(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function hasUnsafeGitInstallPart(value: string, allowSlash: boolean): boolean {
	const decoded = decodeForValidation(value);
	if (decoded === null) {
		return true;
	}
	const candidates = [value, decoded];
	for (const candidate of candidates) {
		if (candidate.includes("\0") || candidate.includes("\\") || candidate.startsWith("/")) {
			return true;
		}
		if (!allowSlash && candidate.includes("/")) {
			return true;
		}
		if (candidate.split("/").includes("..")) {
			return true;
		}
	}
	return false;
}

function buildGitSource(args: { repo: string; host: string; path: string; ref?: string }): GitSource | null {
	if (args.path.startsWith("/")) {
		return null;
	}
	const normalizedPath = args.path.replace(/\.git$/, "").replace(/^\/+/, "");
	if (!args.host || !normalizedPath || normalizedPath.split("/").length < 2) {
		return null;
	}
	if (hasUnsafeGitInstallPart(args.host, false) || hasUnsafeGitInstallPart(normalizedPath, true)) {
		return null;
	}

	return {
		type: "git",
		repo: args.repo,
		host: args.host,
		path: normalizedPath,
		ref: args.ref,
		pinned: Boolean(args.ref),
	};
}

function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let path = "";

	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] ?? "";
		path = scpLikeMatch[2] ?? "";
	} else if (
		repoWithoutRef.startsWith("https://") ||
		repoWithoutRef.startsWith("http://") ||
		repoWithoutRef.startsWith("ssh://") ||
		repoWithoutRef.startsWith("git://")
	) {
		try {
			const parsed = new URL(repoWithoutRef);
			host = parsed.hostname;
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
	} else {
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) {
			return null;
		}
		host = repoWithoutRef.slice(0, slashIndex);
		path = repoWithoutRef.slice(slashIndex + 1);
		if (!host.includes(".") && host !== "localhost") {
			return null;
		}
		repo = `https://${repoWithoutRef}`;
	}

	return buildGitSource({ repo, host, path, ref });
}

/**
 * 将 Git 来源解析为 GitSource。
 *
 * 规则：
 * - 带有 git: 前缀时，接受所有历史简写形式。
 * - 不带 git: 前缀时，只接受显式包含协议的 URL。
 */
export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();
	const hasGitPrefix = trimmed.startsWith("git:");
	const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
		return null;
	}

	const split = splitRef(url);

	const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of hostedCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			const useHttpsPrefix =
				!split.repo.startsWith("http://") &&
				!split.repo.startsWith("https://") &&
				!split.repo.startsWith("ssh://") &&
				!split.repo.startsWith("git://") &&
				!split.repo.startsWith("git@");
			return buildGitSource({
				repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
				host: info.domain || "",
				path: `${info.user}/${info.project}`,
				ref: info.committish || split.ref || undefined,
			});
		}
	}

	const httpsCandidates = [split.ref ? `https://${split.repo}#${split.ref}` : undefined, `https://${url}`].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of httpsCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			return buildGitSource({
				repo: `https://${split.repo}`,
				host: info.domain || "",
				path: `${info.user}/${info.project}`,
				ref: info.committish || split.ref || undefined,
			});
		}
	}

	return parseGenericGitUrl(url);
}
