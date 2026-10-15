import type { Context } from "@earendil-works/chord";
import { SessionFailed } from "../errors.ts";
import type { Cursor, Page } from "../types.ts";

/** 按键管理的等待者。每个等待只结算一次：通过 `resolve`、`rejectAll` 或其 context 被取消。 */
export class Waiters<K, T> {
	readonly #sets = new Map<K, Set<PromiseWithResolvers<T>>>();

	add(key: K, context: Context): Promise<T> {
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason);
		const waiter = Promise.withResolvers<T>();
		const set = this.#sets.get(key) ?? new Set();
		this.#sets.set(key, set.add(waiter));
		if (signal !== undefined) {
			const onAbort = (): void => {
				set.delete(waiter);
				if (set.size === 0 && this.#sets.get(key) === set) this.#sets.delete(key);
				waiter.reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			const detach = (): void => signal.removeEventListener("abort", onAbort);
			waiter.promise.then(detach, detach);
		}
		return waiter.promise;
	}

	keys(): K[] {
		return [...this.#sets.keys()];
	}

	resolve(key: K, value: T): void {
		const set = this.#sets.get(key);
		this.#sets.delete(key);
		for (const waiter of set ?? []) waiter.resolve(value);
	}

	rejectAll(error: unknown): void {
		const sets = [...this.#sets.values()];
		this.#sets.clear();
		for (const set of sets) for (const waiter of set) waiter.reject(error);
	}
}

/** 分页扫描的全部条目，按页序排列。 */
export async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

/** 已关闭 Harness 的拒绝原因：若它是因为会话失败而关闭，则返回携带原因的 `SessionFailed`。 */
export function closedError(session: { readonly failure: { readonly error: unknown } | undefined }): Error {
	const failure = session.failure;
	return failure === undefined ? new Error("Harness is closed") : new SessionFailed(failure.error);
}
