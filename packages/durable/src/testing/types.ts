import type { ExecutionEnv } from "../env/index.ts";
import type { Storage } from "../types.ts";

export interface StorageConformanceAssertions {
	ok(value: unknown, message?: string): void;
	strictEqual(actual: unknown, expected: unknown): void;
	deepEqual(actual: unknown, expected: unknown): void;
	partialDeepEqual(actual: unknown, expected: unknown): void;
	greaterThan(actual: number, expected: number): void;
	rejects(operation: Promise<unknown>, messageIncludes: string): Promise<void>;
}

export type StorageConformanceProvider = (use: (storage: Storage) => Promise<void>) => Promise<void>;

export interface StorageConformanceOptions {
	readonly assertions: StorageConformanceAssertions;
	readonly withStorage: StorageConformanceProvider;
}

export interface StorageConformanceCase {
	readonly name: string;
	run(): Promise<void>;
}

export type EnvConformanceAssertions = StorageConformanceAssertions;

/** 以一个 `cwd` 为全新、空、可写目录的环境调用 `use` 一次，随后清理。 */
export type EnvConformanceProvider = (use: (env: ExecutionEnv) => Promise<void>) => Promise<void>;

export interface EnvConformanceOptions {
	readonly assertions: EnvConformanceAssertions;
	readonly withEnv: EnvConformanceProvider;
	/** 从下一个参数读取 POSIX shell 脚本的程序与标志；默认 `["sh", "-c"]`。 */
	readonly shell?: readonly string[];
	/** shell 的 `ln -s` 是否能创建符号链接；默认 true。 */
	readonly symlinks?: boolean;
}

export interface EnvConformanceCase {
	readonly name: string;
	/** 等待环境监视延迟的用例需要比测试运行器默认超时更长的时间。 */
	readonly timeoutMs?: number;
	run(): Promise<void>;
}
