import { type ExecFileException, execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, type Stats, statSync, unwatchFile, watchFile } from "fs";
import { dirname, join, resolve } from "path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../utils/fs-watch.ts";

export type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * 从 cwd 开始向上查找 Git 元数据路径。
 * 同时支持普通 Git 仓库（.git 是目录）和工作树（.git 是文件）。
 */
export function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** 通过 git 查询当前分支。HEAD 分离或 git 不可用时返回 null。 */
function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	return branch || null;
}

/** 异步通过 git 查询当前分支。HEAD 分离或 git 不可用时返回 null。 */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}

function isWslEnvironment(): boolean {
	return process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function isWindowsMountedRepoPath(repoDir: string): boolean {
	return /^\/mnt\/[a-z](?:\/|$)/i.test(repoDir);
}

function shouldPollGitHead(repoDir: string): boolean {
	return isWslEnvironment() && isWindowsMountedRepoPath(repoDir);
}

/**
 * 提供 Git 分支和扩展状态，这些信息无法通过其他方式供扩展访问。
 * 上下文用量可通过 ctx.getContextUsage() 获取，令牌统计可通过 ctx.sessionManager.getEntries() 获取，模型信息可通过 ctx.model 获取。
 */
export class FooterDataProvider {
	private cwd: string;
	private static readonly WATCH_DEBOUNCE_MS = 500;

	private extensionStatuses = new Map<string, string>();
	private cachedBranch: string | null | undefined = undefined;
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	private headWatchFilePath: string | null = null;
	private headWatchFileListener: ((current: Stats, previous: Stats) => void) | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private reftableTablesListWatcher: FSWatcher | null = null;
	private reftableTablesListPath: string | null = null;
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshInFlight = false;
	private refreshPending = false;
	private disposed = false;

	constructor(cwd: string) {
		this.cwd = cwd;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
	}

	/** 当前 Git 分支；不在仓库中时为 null，处于分离 HEAD 状态时为 "detached"。 */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** 通过 ctx.ui.setStatus() 设置的扩展状态文本。 */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/** 订阅 Git 分支变更，并返回取消订阅的函数。 */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** 内部方法：设置扩展状态。 */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** 内部方法：清除扩展状态。 */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** 有可用模型的不同提供商数量，用于页脚显示。 */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** 内部方法：更新可用提供方数量。 */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	setCwd(cwd: string): void {
		if (this.cwd === cwd) {
			return;
		}

		this.cwd = cwd;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.cachedBranch = undefined;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
		this.notifyBranchChange();
	}

	/** 内部方法：清理。 */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.branchChangeCallbacks.clear();
	}

	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshGitBranchAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	private async refreshGitBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		try {
			const nextBranch = await this.resolveGitBranchAsync();
			if (this.disposed) return;
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				this.cachedBranch = nextBranch;
				this.notifyBranchChange();
				return;
			}
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	private resolveGitBranchSync(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private async resolveGitBranchAsync(): Promise<string | null> {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid"
					? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
					: branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	private clearGitWatchers(): void {
		closeWatcher(this.headWatcher);
		this.headWatcher = null;
		if (this.headWatchFilePath && this.headWatchFileListener) {
			unwatchFile(this.headWatchFilePath, this.headWatchFileListener);
			this.headWatchFilePath = null;
			this.headWatchFileListener = null;
		}
		closeWatcher(this.reftableWatcher);
		this.reftableWatcher = null;
		closeWatcher(this.reftableTablesListWatcher);
		this.reftableTablesListWatcher = null;
		if (this.reftableTablesListPath) {
			unwatchFile(this.reftableTablesListPath);
			this.reftableTablesListPath = null;
		}
		if (this.gitWatcherRetryTimer) {
			clearTimeout(this.gitWatcherRetryTimer);
			this.gitWatcherRetryTimer = null;
		}
	}

	private scheduleGitWatcherRetry(): void {
		if (this.disposed || this.gitWatcherRetryTimer) {
			return;
		}

		this.gitWatcherRetryTimer = setTimeout(() => {
			this.gitWatcherRetryTimer = null;
			this.setupGitWatcher();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	private handleGitWatcherError(): void {
		this.clearGitWatchers();
		this.scheduleGitWatcherRetry();
	}

	private setupGitWatcher(): void {
		this.clearGitWatchers();
		if (!this.gitPaths) return;

		const pollGitHead = shouldPollGitHead(this.gitPaths.repoDir);

		// 监视包含 HEAD 的目录，而不是直接监视 HEAD 文件。
		// Git 采用原子写入（写入临时文件，再重命名覆盖 HEAD），这会改变 inode。
		// 文件 inode 变化后，针对该文件的 fs.watch 监听会失效。
		this.headWatcher = watchWithErrorHandler(
			dirname(this.gitPaths.headPath),
			(_eventType, filename) => {
				if (!filename || filename === "HEAD") {
					this.scheduleRefresh();
				}
			},
			() => this.handleGitWatcherError(),
		);
		if (pollGitHead) {
			this.headWatchFilePath = this.gitPaths.headPath;
			this.headWatchFileListener = (current, previous) => {
				if (
					current.mtimeMs !== previous.mtimeMs ||
					current.ctimeMs !== previous.ctimeMs ||
					current.size !== previous.size
				) {
					this.scheduleRefresh();
				}
			};
			watchFile(this.headWatchFilePath, { interval: 1000 }, this.headWatchFileListener);
		}
		if (!this.headWatcher && !pollGitHead) {
			return;
		}

		// 在 reftable 仓库中，切换分支会更新 reftable 目录中的文件。
		// 而不是 HEAD。单独监听该文件，以便页脚能及时反映这些变更。
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			this.reftableWatcher = watchWithErrorHandler(
				reftableDir,
				() => {
					this.scheduleRefresh();
				},
				() => this.handleGitWatcherError(),
			);
			if (!this.reftableWatcher) {
				return;
			}

			const tablesListPath = join(reftableDir, "tables.list");
			if (existsSync(tablesListPath)) {
				this.reftableTablesListPath = tablesListPath;
				this.reftableTablesListWatcher = watchWithErrorHandler(
					tablesListPath,
					() => {
						this.scheduleRefresh();
					},
					() => this.handleGitWatcherError(),
				);
				if (!this.reftableTablesListWatcher) {
					return;
				}
				watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
					if (
						current.mtimeMs !== previous.mtimeMs ||
						current.ctimeMs !== previous.ctimeMs ||
						current.size !== previous.size
					) {
						this.scheduleRefresh();
					}
				});
			}
		}
	}
}

/** 提供给扩展的只读视图，不包含 setExtensionStatus、setAvailableProviderCount 和 dispose。 */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
