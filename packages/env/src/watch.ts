import type { Context } from "@earendil-works/chord";
import { FileError, type FileWatcher, type WatchChange, type WatchTarget } from "@earendil-works/pi-durable/env";
import { type Connection, isConnectionLost } from "./connection.ts";
import { toFileError } from "./errors.ts";

/** 守护进程的监视方式，与 `NodeExecutionEnv` 的 `NodeWatchOptions` 类似。 */
export interface RemoteWatchOptions {
	/** 强制指定模式；默认情况下，Windows 和无法报告远程变更的文件系统会使用轮询。 */
	mode?: "native" | "polling";
	/** `polling` 模式下两次快照之间的间隔；默认为 2000 毫秒。 */
	pollIntervalMs?: number;
	/** 单个监视器最多覆盖的目录数；默认为 10,000。 */
	maxDirectories?: number;
}

const RECONNECT_FIRST_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * 在守护进程中运行的监视器（即文件所在机器上的 Durable `NodeFileWatcher`）。连接断开后，会在连接恢复时重新打开监视器，
 * 并报告 `overflow`，表示断开期间的变更未被观察到。
 */
export class RemoteWatcher implements FileWatcher {
	readonly #connection: Connection;
	readonly #targets: readonly WatchTarget[];
	readonly #onChange: (change: WatchChange) => void;
	readonly #options: RemoteWatchOptions;
	#mode: "native" | "polling" = "native";
	#closed = false;
	#controller: AbortController | undefined;
	#request: Promise<void> | undefined;
	#wake: (() => void) | undefined;

	private constructor(
		connection: Connection,
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		options: RemoteWatchOptions,
	) {
		this.#connection = connection;
		this.#targets = targets;
		this.#onChange = onChange;
		this.#options = options;
	}

	/** 监视 `targets`（已解析的路径）；无法确认监视范围时，行为与 `NodeFileWatcher.open` 一样会失败。 */
	static async open(
		connection: Connection,
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		options: RemoteWatchOptions = {},
	): Promise<RemoteWatcher> {
		const watcher = new RemoteWatcher(connection, targets, onChange, options);
		await watcher.#start();
		return watcher;
	}

	get mode(): "native" | "polling" {
		return this.#mode;
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#wake?.();
		this.#controller?.abort();
		await this.#request;
	}

	#deliver(change: WatchChange): void {
		if (this.#closed) return;
		try {
			this.#onChange(change);
		} catch {
			// 回调抛出异常时，监视过程仍应继续。
		}
	}

	/** 打开守护进程的文件监视器；确认监视范围后才会完成。 */
	#start(): Promise<void> {
		return new Promise((resolve, reject) => {
			let ready = false;
			const controller = new AbortController();
			this.#controller = controller;
			const request = this.#connection.request(
				"watch",
				{
					targets: this.#targets.map((target) => ({
						path: target.path,
						recursive: target.recursive === true,
						exclude: { hidden: target.exclude?.hidden === true, names: [...(target.exclude?.names ?? [])] },
					})),
					...this.#options,
				},
				{
					signal: controller.signal,
					onEvent: (event) => {
						if (event.kind === "ready") {
							ready = true;
							this.#mode = event.mode === "polling" ? "polling" : "native";
							resolve();
						} else if (event.kind === "change") {
							if (event.mode === "polling") this.#mode = "polling";
							if (event.overflow === true) this.#deliver({ overflow: true });
							else this.#deliver({ paths: event.paths as string[] });
						} else if (event.kind === "error") {
							const code = event.code === "permission_denied" ? "permission_denied" : "invalid";
							this.#deliver({ error: new FileError(code, String(event.message)) });
							this.#closed = true;
						}
					},
				},
			);
			this.#request = request.then(
				() => {},
				(error: unknown) => {
					if (!ready) {
						reject(error);
						return;
					}
					if (this.#closed) return;
					if (isConnectionLost(error)) {
						void this.#reconnect();
						return;
					}
					this.#deliver({ error: toFileError(error) });
					this.#closed = true;
				},
			);
		});
	}

	async #reconnect(): Promise<void> {
		for (let delay = RECONNECT_FIRST_MS; !this.#closed; delay = Math.min(delay * 2, RECONNECT_MAX_MS)) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, delay);
				timer.unref();
				this.#wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.#wake = undefined;
			if (this.#closed) return;
			try {
				await this.#start();
				// 断开连接期间的变更未被观察到。
				this.#deliver({ overflow: true });
				return;
			} catch (error) {
				if (isConnectionLost(error)) continue;
				this.#deliver({ error: toFileError(error) });
				this.#closed = true;
				return;
			}
		}
	}
}
