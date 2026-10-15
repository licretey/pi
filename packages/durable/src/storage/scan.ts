import { StorageRequestError } from "../errors.ts";
import type { Id, ScanOrder } from "../types.ts";

/** 内置存储扫描的起始位置：其排序方向和上一页返回的最后一个 ID。 */
export type ScanStart = {
	readonly order: ScanOrder;
	readonly after: number | undefined;
};

/**
 * 解析扫描的排序方向与位置。游标沿其创建时的排序方向继续，无论查询是否重复指定该方向；指定不同的 `order`
 * 会抛出异常。没有排序方向的游标（早于扫描方向出现的写入）按扫描的默认排序方向继续。
 */
export function scanStart(
	requested: ScanOrder | undefined,
	cursor: Readonly<Record<string, unknown>> | undefined,
	fallback: ScanOrder,
): ScanStart {
	if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
		throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
	}
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	const { after, order: stored } = cursor;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
		throw new StorageRequestError("Invalid storage cursor");
	}
	const order = stored ?? fallback;
	if (requested !== undefined && requested !== order) {
		throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	}
	return { order, after };
}

/** 最后返回项为 `id` 的扫描的续传位置。 */
export function nextCursor(id: Id<string>, order: ScanOrder): { readonly after: number; readonly order: ScanOrder } {
	return { after: id, order };
}
