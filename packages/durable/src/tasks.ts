import type { Task, TaskDefinition } from "./types.ts";

/** 定义一个可执行任务。注册到注册表中，执行架（Harness）即可运行这类任务。 */
export function defineTask<I, S extends { phase: string }, R, H extends object = object>(
	definition: TaskDefinition<I, S, R, H>,
): Task<I, S, R, H> {
	return { definition };
}
