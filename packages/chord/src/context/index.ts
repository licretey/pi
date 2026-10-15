import type { Context, ContextKey } from "../types.ts";

const ABORT_SIGNAL_CONTEXT_KEY: ContextKey<AbortSignal | undefined> = Object.freeze({
	token: Symbol("chord.abortSignal"),
});

abstract class BaseContext implements Context {
	abstract value<T>(key: ContextKey<T>): T | undefined;
	abstract toString(): string;

	get abortSignal(): AbortSignal | undefined {
		return this.value(ABORT_SIGNAL_CONTEXT_KEY);
	}
}

class EmptyContext extends BaseContext {
	readonly #name: string;

	constructor(name: string) {
		super();
		this.#name = name;
	}

	value<T>(_key: ContextKey<T>): T | undefined {
		return undefined;
	}

	toString(): string {
		return this.#name;
	}
}

class ContextValue<T> extends BaseContext {
	readonly #parent: Context;
	readonly #key: ContextKey<T>;
	readonly #value: T;

	constructor(parent: Context, key: ContextKey<T>, value: T) {
		super();
		this.#parent = parent;
		this.#key = key;
		this.#value = value;
	}

	value<Value>(key: ContextKey<Value>): Value | undefined {
		if (key.token === this.#key.token) return this.#value as unknown as Value;
		return this.#parent.value(key);
	}

	toString(): string {
		return `${this.#parent}.WithValue(${this.#key.token.description ?? "anonymous"})`;
	}
}

export const BACKGROUND_CONTEXT: Context = new EmptyContext("[Context BACKGROUND_CONTEXT]");
export const TODO_CONTEXT: Context = new EmptyContext("[Context TODO_CONTEXT]");

export function createContextKey<T>(description: string): ContextKey<T> {
	return Object.freeze({ token: Symbol(description) });
}

/** 派生出一个包含一个新增或替换值的 context。 */
export function withContextValue<T>(key: ContextKey<T>, value: T, parent: Context): Context {
	return new ContextValue(parent, key, value);
}

/**
 * 派生出一个由父 signal 或传入 signal 之一取消的 context。
 * 父 context 保持不变。
 */
export function withAbortSignal(signal: AbortSignal, context: Context): Context {
	const parentSignal = context.abortSignal;
	const combined = parentSignal === undefined ? signal : AbortSignal.any([parentSignal, signal]);
	return withContextValue(ABORT_SIGNAL_CONTEXT_KEY, combined, context);
}

/** 派生出一个保留全部值但去掉调用方取消机制的 context。仅用于必须执行的清理。 */
export function withoutAbortSignal(context: Context): Context {
	return withContextValue(ABORT_SIGNAL_CONTEXT_KEY, undefined, context);
}

/** 派生出一个可独立取消的子 context。 */
export function withCancel(context: Context): {
	readonly context: Context;
	readonly cancel: (reason?: unknown) => void;
} {
	const controller = new AbortController();
	return {
		context: withAbortSignal(controller.signal, context),
		cancel: (reason?: unknown) => controller.abort(reason),
	};
}

/**
 * 观察一个 promise，直到它落定或本次调用被取消。
 * 取消只会拒绝这个等待者；不会取消底层的 promise。
 */
export function awaitWithContext<T>(promise: Promise<T>, context: Context): Promise<T> {
	const signal = context.abortSignal;
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
