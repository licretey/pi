/** 可移植 SQLite 存储核心支持的值类型。 */
export type SqliteValue = null | number | bigint | string | Uint8Array;

/**
 * 数据库与其事务句柄共用的异步 SQL 操作。
 *
 * `exec` 运行不带绑定的 SQL 文本，可包含多条语句。`run`、`get`、`all` 执行单条语句并使用位置绑定。
 * 适配器可以按 SQL 文本缓存预编译语句，因此调用方以绑定传递值，而不是做字符串拼接。
 */
export interface SqliteExecutor {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: SqliteValue[]): Promise<void>;
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined>;
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]>;
}

/**
 * `SqliteStorage` 所需的最小数据库门面。
 *
 * 所有操作都是异步的，因此适配器可以在执行架（harness）运行时之外运行。
 *
 * `transaction` 会向回调传入一个事务句柄。事务中的所有工作都必须使用该句柄；回调落定后句柄即失效。
 * 适配器必须把无关操作和其他事务排队，直到该事务结束。返回的 promise 在提交或回滚后落定。因此在回调内
 * 调用数据库本身（包括 `transaction` 或 `close`）会等待该事务，且永远不会落定。
 *
 * 当回调 reject 时，适配器必须先回滚事务，再以同一个错误 reject。若回滚失败，必须以不同的错误 reject
 * （例如 `AggregateError`），使调用方不会把回调错误误认为已保证回滚。
 */
export interface SqliteDatabase extends SqliteExecutor {
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}
