import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";
import { SqliteStorage } from "./storage.ts";

/** Durable Object SQL 绑定可接受并返回的值类型。 */
type DurableObjectSqlValue = ArrayBuffer | string | number | null;

/**
 * 本适配器用到的 SQLite Durable Object `ctx.storage` 的部分成员，以结构化类型声明，
 * 使本包无需依赖 Workers 类型。
 */
export type DurableObjectSqliteStorage = {
	readonly sql: {
		exec(query: string, ...bindings: DurableObjectSqlValue[]): { toArray(): Record<string, DurableObjectSqlValue>[] };
	};
	transaction<T>(closure: () => Promise<T>): Promise<T>;
};

/** 按调用顺序逐个运行操作，因此一个事务会排除所有其他操作。 */
class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return result;
	}
}

/** Durable Object SQL 以双精度浮点绑定数字：超出安全整数范围的 `bigint` 会丢失精度。 */
function bindValue(value: SqliteValue): DurableObjectSqlValue {
	if (value instanceof Uint8Array) return value.slice().buffer as ArrayBuffer;
	if (typeof value !== "bigint") return value;
	if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new RangeError(`Durable Object SQL cannot bind ${value} without losing precision`);
	}
	return Number(value);
}

const bind = (params: readonly SqliteValue[]): DurableObjectSqlValue[] => params.map(bindValue);

/** 按原样返回的行，`BLOB` 列就地转换为 `Uint8Array`；不做其他拷贝。 */
function rows<T>(rows: Record<string, DurableObjectSqlValue>[]): T[] {
	for (const row of rows) {
		for (const key in row) {
			const value = row[key];
			if (value instanceof ArrayBuffer) (row as Record<string, unknown>)[key] = new Uint8Array(value);
		}
	}
	return rows as T[];
}

/** 通过 `ctx.storage.sql` 执行 SQL，它没有独立的 prepare 步骤。 */
class DurableObjectSqliteExecutor implements SqliteExecutor {
	protected readonly storage: DurableObjectSqliteStorage;

	constructor(storage: DurableObjectSqliteStorage) {
		this.storage = storage;
	}

	async exec(sql: string): Promise<void> {
		this.check();
		this.storage.sql.exec(sql);
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.check();
		this.storage.sql.exec(sql, ...bind(params));
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		this.check();
		return rows<T>(this.storage.sql.exec(sql, ...bind(params)).toArray())[0];
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.check();
		return rows<T>(this.storage.sql.exec(sql, ...bind(params)).toArray());
	}

	/** 当此句柄可能不能再执行 SQL 时抛出。 */
	protected check(): void {}
}

/** 事务回调拿到的句柄；回调落定后即失效。 */
class DurableObjectSqliteTransaction extends DurableObjectSqliteExecutor {
	active = true;

	protected override check(): void {
		if (!this.active) throw new Error("SQLite transaction handle is no longer active");
	}
}

/**
 * 面向 Cloudflare Durable Object SQLite 存储的 `SqliteDatabase` 适配器。整数是 JavaScript number；
 * 绑定超出安全整数范围的 `bigint` 会抛出异常。
 */
export class DurableObjectSqliteDatabase extends DurableObjectSqliteExecutor implements SqliteDatabase {
	private readonly queue = new SerialQueue();

	override exec(sql: string): Promise<void> {
		return this.queue.run(() => super.exec(sql));
	}

	override run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.queue.run(() => super.run(sql, ...params));
	}

	override get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.queue.run(() => super.get<T>(sql, ...params));
	}

	override all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.queue.run(() => super.all<T>(sql, ...params));
	}

	/** `ctx.storage.transaction()` 在回调 resolve 时提交、reject 时回滚。 */
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.queue.run(() =>
			this.storage.transaction(async () => {
				const transaction = new DurableObjectSqliteTransaction(this.storage);
				try {
					return await callback(transaction);
				} finally {
					transaction.active = false;
				}
			}),
		);
	}

	/** 等待排队的工作完成。Durable Object 拥有自己的存储，因此没有其他需要关闭的东西。 */
	close(): Promise<void> {
		return this.queue.run(() => {});
	}
}

/** 在 SQLite Durable Object 的 `ctx.storage` 上打开持久存储。 */
export function openDurableObjectSqliteStorage(storage: DurableObjectSqliteStorage): Promise<SqliteStorage> {
	return SqliteStorage.open(new DurableObjectSqliteDatabase(storage));
}
