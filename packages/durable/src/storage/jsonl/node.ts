import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "../../env/node.ts";
import { JsonlStorage, type JsonlStorageOptions } from "./storage.ts";

/** 使用本地 Node 文件系统打开或创建一个 JSONL 存储目录。 */
export async function openNodeJsonlStorage(
	directory: string,
	context: Context,
	options: JsonlStorageOptions = {},
): Promise<JsonlStorage> {
	return JsonlStorage.open(directory, new NodeExecutionEnv({ cwd: process.cwd() }), context, options);
}

export { JsonlStorage, type JsonlStorageOptions } from "./storage.ts";
