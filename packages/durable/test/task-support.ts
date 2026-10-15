import { createModels } from "@earendil-works/pi-ai";
import {
	type AnyTask,
	createRegistry,
	defineExtension,
	Harness,
	type HarnessSettings,
	type Registry,
	type RegistryReader,
	type Storage,
} from "@earendil-works/pi-durable";
import { context, flush } from "./session-support.ts";

export type Deferred<T = void> = {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
};

export function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** 信号中止时使用其原因拒绝 Promise；用于阻塞到取消为止的处理器。 */
export function aborted(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** 持续推进宏任务，直到 `check` 条件成立。 */
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await flush();
	}
	throw new Error("Condition was not reached");
}

/** 清空待处理工作后，检查 `promise` 是否已结束。 */
export async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	promise.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	await flush();
	return done;
}

/** 打开一个注册表中包含 `tasks` 的 Harness；收集传递给 `onReport` 的失败信息。 */
export async function openTasks(
	storage: Storage,
	tasks: readonly AnyTask[],
	options: { readonly registry?: Registry; readonly now?: () => number; readonly settings?: HarnessSettings } = {},
): Promise<{ readonly harness: Harness; readonly registry: Registry; readonly reports: unknown[] }> {
	const registry = options.registry ?? createRegistry();
	if (tasks.length > 0) registry.install(defineExtension({ name: "tasks", tasks }));
	const reports: unknown[] = [];
	const harness = await Harness.open(
		storage,
		{
			models: createModels(),
			registry,
			onReport: (error) => reports.push(error),
			...(options.now === undefined ? {} : { now: options.now }),
			...(options.settings === undefined ? {} : { settings: options.settings }),
		},
		context,
	);
	return { harness, registry, reports };
}

/** 将任务以 `result` 结果置为完成状态的下一状态。 */
export function completed<R>(result: R) {
	return { status: "terminal", outcome: { status: "completed", result } } as const;
}

/** 将任务置为中止状态的下一状态。 */
export function abortedWith(reason: string) {
	return { status: "terminal", outcome: { status: "aborted", reason } } as const;
}

/** 统计当前有效订阅数的注册表读取器。 */
export function countingReader(registry: Registry): RegistryReader & { subscriptions(): number } {
	let count = 0;
	return {
		snapshot: () => registry.snapshot(),
		subscribe: (listener) => {
			count++;
			const unsubscribe = registry.subscribe(listener);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				count--;
				unsubscribe();
			};
		},
		subscriptions: () => count,
	};
}
