import type { Context } from "@earendil-works/chord";
import { type ExecutionEnv, getOrThrow } from "../env/index.ts";

/** 每个文件变更链的尾端，以文件系统 id 和规范路径为键。 */
const queues = new Map<string, Promise<void>>();

async function mutationKey(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const absolutePath = getOrThrow(await env.absolutePath(path, context));
	return `${env.id}\0${await canonical(env, absolutePath, context)}`;
}

/**
 * 规范路径；对尚不存在的文件，取其规范化父目录拼接其名称，这样一次创建文件的 `write` 与之后对它的变更
 * 即使在一个符号链接目录下也共享同一个键。
 */
async function canonical(env: ExecutionEnv, absolutePath: string, context: Context): Promise<string> {
	const result = await env.canonicalPath(absolutePath, context);
	if (result.ok) return result.value;
	if (result.error.code === "not_supported") return absolutePath;
	if (result.error.code !== "not_found") throw result.error;
	// 文件系统会拆分路径，因此名称中可能包含在其他位置充当分隔符的字符。
	const parent = getOrThrow(await env.joinPath([absolutePath, ".."], context));
	if (parent === absolutePath || !absolutePath.startsWith(parent)) return absolutePath;
	const name = absolutePath.slice(parent.length + (/[/\\]$/.test(parent) ? 0 : 1));
	return getOrThrow(await env.joinPath([await canonical(env, parent, context), name], context));
}

/**
 * 在本进程内串行化对同一文件的 `edit` 和 `write` 变更：文件系统 id 与规范路径相同即视为同一文件，
 * 无论调用拿到的是哪个环境对象。其他文件、其他文件系统永不等待。对同一文件的并发调用按其键解析的
 * 顺序运行。并非针对 `bash` 或其他进程的锁。
 */
export async function withFileMutationQueue<T>(
	env: ExecutionEnv,
	path: string,
	fn: () => Promise<T>,
	context: Context,
): Promise<T> {
	const key = await mutationKey(env, path, context);
	// 不加 await 地占据槽位，这样没有其他调用能在中间插队。
	const previous = queues.get(key) ?? Promise.resolve();
	let release = (): void => {};
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => done);
	queues.set(key, tail);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (queues.get(key) === tail) queues.delete(key);
	}
}
