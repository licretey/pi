import { createHash } from "node:crypto";
import { type FSWatcher, watch as fsWatch, type Stats } from "node:fs";
import { lstat, readdir, readFile, stat, statfs } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { FileError, type FileWatcher, type WatchChange, type WatchTarget } from "./index.ts";

/** `NodeExecutionEnv` 如何进行监视。 */
export interface NodeWatchOptions {
	/**
	 * 强制指定模式。默认情况下，Windows 上会选择 `polling`（原生监视器会保持目录打开，从而阻碍重命名其父目录），
	 * 对不上报远程变更的文件系统也会选择 `polling`。
	 */
	mode?: "native" | "polling";
	/** `polling` 模式下快照之间的间隔；默认 2000 毫秒。 */
	pollIntervalMs?: number;
	/** 单个监视器可覆盖的最大目录数；默认 10,000。 */
	maxDirectories?: number;
}

type ResolvedTarget = {
	readonly path: string;
	readonly recursive: boolean;
	readonly hidden: boolean;
	readonly names: ReadonlySet<string>;
};

/** 快照为每个路径记住的信息。目录与祖先仅按身份（identity）比较。 */
type Entry = {
	readonly kind: "file" | "directory" | "symlink" | "other";
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly hash?: string;
};

type Snapshot = Map<string, Entry>;

/** 原生监视器及其安装对象的身份：路径被另一个文件替换后需要新的监视器。 */
type Installed = { readonly watcher: FSWatcher; readonly dev: number; readonly ino: number };

/** 一次扫描的结果：快照，以及作为文件符号链接的目标，这些文件需要各自的监视器。 */
type Scan = { readonly snapshot: Snapshot; readonly linkedFiles: ReadonlySet<string> };

const DEBOUNCE_MS = 50;
/**
 * 在 macOS 上，`fs.watch` 返回时 libuv 的 FSEvents 流尚未就绪，期间的变更永远不会被上报
 * （约占调用后立即做出变更的 2%，100 毫秒后则没有）。安装监视器这么久之后再重扫一次即可捕获它们。
 */
const FSEVENTS_SETTLE_MS = 500;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_MAX_DIRECTORIES = 10_000;
/** 在 polling 模式下，最近修改过的小文件还会按内容比较：在文件系统时间戳粒度内的第二次写入，可能保住大小和修改时间。 */
const HASH_MAX_BYTES = 256 * 1024;
const HASH_RECENT_MS = 5000;

/** Linux `statfs` 的文件系统魔数：这些文件系统接受监视，但不上报在别处做出的变更。 */
const UNRELIABLE_FILE_SYSTEMS = new Set([
	0x6969, // NFS
	0x517b, // SMB
	0xff534d42, // CIFS
	0xfe534d42, // SMB2
	0x65735546, // FUSE（sshfs、Android 共享存储）
	0x01021997, // 9P (WSL2 Windows drives)
	0x0bd00bd0, // Lustre
	0x47504653, // GPFS
	0x00c36400, // Ceph
	0x5346414f, // OpenAFS
	0x6b414653, // kAFS
	0x5dca2df5, // sdcardfs
]);

class BudgetExceeded extends Error {}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function isDenied(error: unknown): boolean {
	return isNodeError(error) && (error.code === "EACCES" || error.code === "EPERM");
}

function entryOf(stats: Stats, hash?: string): Entry {
	const kind = stats.isFile()
		? "file"
		: stats.isDirectory()
			? "directory"
			: stats.isSymbolicLink()
				? "symlink"
				: "other";
	return {
		kind,
		dev: stats.dev,
		ino: stats.ino,
		size: kind === "directory" ? 0 : stats.size,
		mtimeMs: kind === "directory" ? 0 : stats.mtimeMs,
		...(hash === undefined ? {} : { hash }),
	};
}

function sameEntry(a: Entry, b: Entry): boolean {
	return (
		a.kind === b.kind &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.hash === b.hash
	);
}

/** `path` 的各个祖先，由近及远，直到根目录。 */
function ancestorsOf(path: string): string[] {
	const result: string[] = [];
	for (let current = dirname(path); ; current = dirname(current)) {
		result.push(current);
		if (dirname(current) === current) return result;
	}
}

/** `path` 是否为 `ancestor` 本身或位于其之下。 */
function isWithin(path: string, ancestor: string): boolean {
	return path === ancestor || path.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

function excluded(target: ResolvedTarget, name: string): boolean {
	return (target.hidden && name.startsWith(".")) || target.names.has(name);
}

/**
 * 基于快照进行监视：原生事件仅触发一次去抖的重扫，变更即快照之间的差异再加上事件路径。
 * 因此被替换的文件、被重命名或重建的祖先、或连同内容一起创建的目录，都绝不依赖操作系统发送了哪些事件。
 * 新目录会先获得监视器、之后才被再次扫描，所以监视器存在之前写入其中的内容不会漏掉。
 */
export class NodeFileWatcher implements FileWatcher {
	readonly #targets: readonly ResolvedTarget[];
	readonly #onChange: (change: WatchChange) => void;
	readonly #pollIntervalMs: number;
	readonly #maxDirectories: number;
	readonly #watchers = new Map<string, Installed>();
	readonly #events = new Set<string>();
	#mode: "native" | "polling";
	#snapshot: Snapshot = new Map();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#settleTimer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	#dirty = false;
	#closed = false;

	private constructor(
		targets: readonly ResolvedTarget[],
		onChange: (change: WatchChange) => void,
		mode: "native" | "polling",
		options: NodeWatchOptions,
	) {
		this.#targets = targets;
		this.#onChange = onChange;
		this.#mode = mode;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
		this.#maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
	}

	/** 建立覆盖：先装监视器，再生成快照供之后的变更比较。 */
	static async open(
		targets: readonly WatchTarget[],
		resolvePath: (path: string) => string,
		onChange: (change: WatchChange) => void,
		options: NodeWatchOptions,
	): Promise<NodeFileWatcher> {
		const resolved = targets.map((target) => ({
			path: resolvePath(target.path),
			recursive: target.recursive === true,
			hidden: target.exclude?.hidden === true,
			names: new Set(target.exclude?.names ?? []),
		}));
		// Windows 拒绝在另一个目录在其下方处于打开状态时重命名该目录，而原生监视器会让每个被监视的
		// 目录保持打开：监视会破坏其父目录的重命名，所以 Windows 采用轮询。
		const mode =
			options.mode ??
			(process.platform === "win32" || (await anyUnreliable(resolved.map((target) => target.path)))
				? "polling"
				: "native");
		const watcher = new NodeFileWatcher(resolved, onChange, mode, options);
		try {
			await watcher.#sync(false);
		} catch (error) {
			watcher.#stop();
			if (error instanceof BudgetExceeded) throw new FileError("invalid", error.message);
			throw error;
		}
		watcher.#schedulePoll();
		return watcher;
	}

	get mode(): "native" | "polling" {
		return this.#mode;
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#stop();
		await this.#running;
	}

	#stop(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		clearTimeout(this.#settleTimer);
		this.#settleTimer = undefined;
		for (const { watcher } of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
	}

	#deliver(change: WatchChange): void {
		if (this.#closed) return;
		try {
			this.#onChange(change);
		} catch {
			// 抛异常的回调绝不能让监视停止。
		}
	}

	#schedulePoll(): void {
		if (this.#closed || this.#mode !== "polling") return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#flush().finally(() => this.#schedulePoll());
		}, this.#pollIntervalMs);
	}

	#scheduleFlush(): void {
		if (this.#closed || this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#flush();
		}, DEBOUNCE_MS);
	}

	#scheduleSettle(): void {
		if (this.#closed) return;
		clearTimeout(this.#settleTimer);
		this.#settleTimer = setTimeout(() => {
			this.#settleTimer = undefined;
			void this.#flush();
		}, FSEVENTS_SETTLE_MS);
	}

	#flush(): Promise<void> {
		if (this.#running !== undefined) {
			this.#dirty = true;
			return this.#running;
		}
		this.#running = (async () => {
			try {
				do {
					this.#dirty = false;
					const events = [...this.#events];
					this.#events.clear();
					const changed = await this.#sync(true);
					for (const path of events) changed.add(path);
					if (changed.size > 0) this.#deliver({ paths: [...changed].sort() });
				} while (this.#dirty && !this.#closed);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const fileError =
					error instanceof FileError
						? error
						: new FileError(isDenied(error) ? "permission_denied" : "invalid", message);
				this.#deliver({ error: fileError });
				this.#stop();
			} finally {
				this.#running = undefined;
			}
		})();
		return this.#running;
	}

	/** 重扫并上报差异，为新目录安装监视器，反复重扫直到没有新目录。 */
	async #sync(report: boolean): Promise<Set<string>> {
		const changed = new Set<string>();
		for (let round = 0; round < 10 && !this.#closed; round++) {
			const scan = await this.#scan();
			// 扫描期间已关闭：此时安装监视器会泄漏它们。
			if (this.#closed) break;
			const next = scan.snapshot;
			if (report) for (const path of this.#diff(this.#snapshot, next)) changed.add(path);
			this.#snapshot = next;
			if (this.#mode === "polling" || !this.#reconcileWatchers(scan)) break;
			if (process.platform === "darwin") this.#scheduleSettle();
			// 在新目录的监视器存在之前写入其中的一切，会在下一轮显现出来。
			report = true;
		}
		return changed;
	}

	#diff(previous: Snapshot, next: Snapshot): string[] {
		const changed: string[] = [];
		for (const [path, entry] of next) {
			const before = previous.get(path);
			if (before === undefined || !sameEntry(before, entry)) changed.push(this.#reported(path));
		}
		for (const path of previous.keys()) if (!next.has(path)) changed.push(this.#reported(path));
		return changed;
	}

	/** 身份发生变化的祖先移动了其下所有目标；上报那些目标。 */
	#reported(path: string): string {
		if (this.#targets.some((target) => isWithin(path, target.path))) return path;
		return this.#targets.find((target) => isWithin(target.path, path))?.path ?? path;
	}

	async #scan(): Promise<Scan> {
		const snapshot: Snapshot = new Map();
		const linkedFiles = new Set<string>();
		// 目录只计数一次，但每个目标各遍历一次：重叠的目标在递归与排除规则上不同，
		// 为某个目标记录过的条目，对另一个目标仍要继续下钻。
		const counted = new Set<string>();
		const traversed = new Set<string>();
		/** 已列出条目的种类（不跟随链接）：链接到目录的目标由 `stat` 记录，
		 * 但递归目标下方的符号链接不会被跟随。 */
		const listed = new Map<string, Entry["kind"]>();
		const countDirectory = (path: string): void => {
			counted.add(path);
			if (counted.size > this.#maxDirectories) {
				throw new BudgetExceeded(`Watched paths exceed ${this.#maxDirectories} directories`);
			}
		};
		const record = async (path: string, stats: Stats): Promise<void> => {
			let hash: string | undefined;
			if (
				this.#mode === "polling" &&
				stats.isFile() &&
				stats.size <= HASH_MAX_BYTES &&
				Date.now() - stats.mtimeMs < HASH_RECENT_MS
			) {
				hash = await readFile(path).then(
					(content) => createHash("sha256").update(content).digest("hex"),
					() => undefined,
				);
			}
			snapshot.set(path, entryOf(stats, hash));
		};
		const scanDirectory = async (index: number, target: ResolvedTarget, directory: string): Promise<void> => {
			const key = `${index}\0${directory}`;
			if (traversed.has(key)) return;
			traversed.add(key);
			let names: string[];
			try {
				names = await readdir(directory);
			} catch (error) {
				// 被监视的目录本身必须可读；其下方的不可读目录会被跳过。
				if (directory === target.path && isDenied(error)) throw error;
				if (isNodeError(error) && ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error.code ?? "")) return;
				throw error;
			}
			for (const name of names) {
				if (excluded(target, name)) continue;
				const path = `${directory.endsWith(sep) ? directory : directory + sep}${name}`;
				let kind = listed.get(path);
				if (kind === undefined) {
					const stats = await lstat(path).catch(() => undefined);
					if (stats === undefined) continue;
					kind = entryOf(stats).kind;
					listed.set(path, kind);
					// 目标自身的条目（跟随链接）优先于另一个目标对它的列出。
					if (!snapshot.has(path)) await record(path, stats);
				}
				if (target.recursive && kind === "directory") {
					countDirectory(path);
					await scanDirectory(index, target, path);
				}
			}
		};
		for (const [index, target] of this.#targets.entries()) {
			for (const ancestor of ancestorsOf(target.path)) {
				if (snapshot.has(ancestor)) continue;
				const stats = await lstat(ancestor).catch(() => undefined);
				// 只按身份：祖先自身的时间戳会随任何无关兄弟的变化而改变。
				if (stats !== undefined) snapshot.set(ancestor, { ...entryOf(stats), size: 0, mtimeMs: 0 });
			}
			// 目标本身可能是指向被监视对象的符号链接；要跟随它。缺失的目标会一直被监视直至其被创建；
			// 因权限不足而无法触达的目标则失败。
			let stats: Stats;
			try {
				stats = await stat(target.path);
			} catch (error) {
				if (isDenied(error)) throw error;
				continue;
			}
			await record(target.path, stats);
			if (stats.isFile() && (await lstat(target.path).catch(() => undefined))?.isSymbolicLink()) {
				linkedFiles.add(target.path);
			}
			if (stats.isDirectory()) {
				countDirectory(target.path);
				await scanDirectory(index, target, target.path);
			}
		}
		return { snapshot, linkedFiles };
	}

	/**
	 * 监视每个目标的全部现存祖先、每个目标目录、每个作为指向文件的符号链接的目标（对那些文件的变更不属于
	 * 链接所在目录的事件），以及在 Linux 上递归目标下的每个目录（其他平台每个目标一个递归监视器）。
	 * 返回是否新加了监视器。
	 */
	#reconcileWatchers({ snapshot, linkedFiles }: Scan): boolean {
		const wanted = new Map<string, boolean>();
		for (const path of linkedFiles) wanted.set(path, false);
		const perDirectory = process.platform === "linux" || process.platform === "android";
		for (const target of this.#targets) {
			for (const ancestor of ancestorsOf(target.path)) {
				if (snapshot.get(ancestor)?.kind === "directory" && !wanted.has(ancestor)) wanted.set(ancestor, false);
			}
			if (snapshot.get(target.path)?.kind !== "directory") continue;
			const recursiveRoot = target.recursive && !perDirectory;
			wanted.set(target.path, recursiveRoot);
			if (target.recursive && perDirectory) {
				for (const [path, entry] of snapshot) {
					if (entry.kind === "directory" && path !== target.path && isWithin(path, target.path)) {
						wanted.set(path, false);
					}
				}
			}
		}
		for (const [path, installed] of this.#watchers) {
			const entry = snapshot.get(path);
			// 已消失，或已被替换：监视器跟随它所安装的目录，而不是路径。
			if (!wanted.has(path) || entry === undefined || entry.dev !== installed.dev || entry.ino !== installed.ino) {
				installed.watcher.close();
				this.#watchers.delete(path);
			}
		}
		let added = false;
		for (const [path, recursive] of wanted) {
			const entry = snapshot.get(path);
			if (this.#watchers.has(path) || entry === undefined) continue;
			const linked = linkedFiles.has(path);
			try {
				const watcher = fsWatch(path, { recursive, persistent: false }, (_event, filename) =>
					linked
						? this.#onLinkedFileEvent(path)
						: this.#onEvent(path, filename === null ? undefined : String(filename)),
				);
				// 被监视目录消失或出错：重扫一次，同时也会替换掉该监视器。
				watcher.on("error", () => {
					watcher.close();
					if (this.#watchers.get(path)?.watcher === watcher) this.#watchers.delete(path);
					this.#scheduleFlush();
				});
				this.#watchers.set(path, { watcher, dev: entry.dev, ino: entry.ino });
				added = true;
			} catch (error) {
				// 监视额度耗尽或不支持：从现在起改为比较快照，并声明覆盖曾经不可靠。
				if (isNodeError(error) && error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "EPERM") {
					this.#switchToPolling();
					return false;
				}
			}
		}
		return added;
	}

	#switchToPolling(): void {
		if (this.#mode === "polling") return;
		this.#mode = "polling";
		for (const { watcher } of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
		this.#deliver({ overflow: true });
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#schedulePoll();
	}

	#onEvent(directory: string, filename: string | undefined): void {
		if (this.#closed) return;
		const path =
			filename === undefined ? directory : `${directory.endsWith(sep) ? directory : directory + sep}${filename}`;
		// 关于祖先的无关兄弟、或被排除条目的事件一律忽略。
		const relevant = this.#inScope(path);
		if (relevant) this.#events.add(this.#reported(path));
		if (relevant || filename === undefined) this.#scheduleFlush();
	}

	/** 目标所链接的文件发生了变化：上报该目标。 */
	#onLinkedFileEvent(target: string): void {
		if (this.#closed) return;
		this.#events.add(target);
		this.#scheduleFlush();
	}

	#inScope(path: string): boolean {
		for (const target of this.#targets) {
			if (isWithin(target.path, path)) return true;
			if (!isWithin(path, target.path) || path === target.path) continue;
			const components = relative(target.path, path).split(sep);
			if (!target.recursive && components.length > 1) continue;
			if (components.some((name) => excluded(target, name))) continue;
			return true;
		}
		return false;
	}
}

/** 任何路径或其最近现存祖先，是否位于不上报远程变更的文件系统上。 */
async function anyUnreliable(paths: readonly string[]): Promise<boolean> {
	if (process.platform !== "linux" && process.platform !== "android") return false;
	for (const path of paths) {
		for (const candidate of [path, ...ancestorsOf(path)]) {
			const info = await statfs(candidate).catch(() => undefined);
			if (info === undefined) continue;
			if (UNRELIABLE_FILE_SYSTEMS.has(info.type)) return true;
			break;
		}
	}
	return false;
}
