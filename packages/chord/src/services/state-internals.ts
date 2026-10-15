import type { Op } from "../delta/index.ts";
import type { Context } from "../types.ts";

export interface ReplicatedStateInternals {
	/** 原子地捕获不可变值及其对应的发布序列号。 */
	snapshot(): { readonly value: unknown; readonly sequence: number };
	subscribe(listener: (ops: readonly Op[], sequence: number, context: Context) => void): () => void;
}

const sources = new WeakMap<object, ReplicatedStateInternals>();

export function registerReplicatedStateInternals(value: object, internals: ReplicatedStateInternals): void {
	sources.set(value, internals);
}

export function getReplicatedStateInternals(value: unknown): ReplicatedStateInternals | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return sources.get(value);
}
