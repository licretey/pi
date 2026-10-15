import type { AnyModel } from "./types.ts";

export interface ModelsStoreEntry {
	/** 每种类型的已持久化模型。 */
	models: readonly AnyModel[];
	/** 来自远程目录 Last-Modified 头的 Unix 时间戳。 */
	lastModified?: number;
	/** 上次完成的远程检查的 Unix 时间戳。 */
	checkedAt?: number;
	/**
	 * 来自远程目录 ETag 头的不透明校验器，按原样存储（含引号），
	 * 并作为 If-None-Match 回传。
	 */
	etag?: string;
}

export interface ModelsStoreOperationOptions {
	signal?: AbortSignal;
}

/** 以 provider ID 为键的持久化模型目录。 */
export interface ModelsStore {
	read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined>;
	write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void>;
	delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void>;
}

export class InMemoryModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const entry = this.entries.get(providerId);
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.delete(providerId);
	}
}
