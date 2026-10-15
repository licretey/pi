export interface PromiseResolvers<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

/** 仓库的 TypeScript 标准库基线升级至 ES2024 后，可改用 `Promise.withResolvers()` 并移除此函数。 */
export function createPromiseResolvers<T>(): PromiseResolvers<T> {
	let resolve!: PromiseResolvers<T>["resolve"];
	let reject!: PromiseResolvers<T>["reject"];
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
