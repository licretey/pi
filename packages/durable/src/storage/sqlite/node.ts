import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "./database.ts";
import { SqliteStorage } from "./storage.ts";

/** 持久存储文件的 Node SQLite 连接设置。 */
export type NodeSqliteStorageOptions = {
	/** SQLite WAL 自动检查点阈值。SQLite 和本适配器默认 1,000 页；0 表示禁用。 */
	readonly walAutoCheckpointPages?: number;
	/** SQLite 等待竞争文件锁的时长。SQLite 默认 0；本适配器默认 5,000 毫秒。 */
	readonly busyTimeoutMs?: number;
};

const DEFAULT_WAL_AUTO_CHECKPOINT_PAGES = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

type TransactionScope = { active: boolean };

const ignore = (): void => {};

/**
 * 按调用顺序运行操作。没有正在运行或排队的操作时立即开始；否则等所有先前的操作完成。
 * 一个异步操作会占住队列直到它落定。
 */
class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;

	run<T>(operation: () => T): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		try {
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	runAsync<T>(operation: () => Promise<T>): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		this.pending++;
		// 在操作开始之前先发布屏障，使它同步发起的调用排到屏障之后等待。
		const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
		this.tail = barrier;
		let started: Promise<T>;
		try {
			started = operation();
		} catch (error) {
			started = Promise.reject(error);
		}
		return started.finally(() => {
			this.pending--;
			releaseBarrier();
		});
	}

	private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		this.pending++;
		return this.release(this.tail.then(operation));
	}

	private release<T>(operation: Promise<T>): Promise<T> {
		const settled = operation.finally(() => {
			this.pending--;
		});
		this.tail = settled.then(ignore, ignore);
		return settled;
	}
}

/**
 * 在单个连接上执行 SQL。预编译语句按 SQL 文本在每个连接上缓存，因此数据库与其事务句柄可以跨事务共享它们。
 */
abstract class NodeSqliteExecutor implements SqliteExecutor {
	protected readonly database: DatabaseSync;
	protected readonly statements: Map<string, StatementSync>;

	constructor(database: DatabaseSync, statements: Map<string, StatementSync>) {
		this.database = database;
		this.statements = statements;
	}

	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			this.statement(sql).run(...params);
		});
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => this.statement(sql).get(...params) as T | undefined);
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => this.statement(sql).all(...params) as T[]);
	}

	protected abstract runOperation<T>(operation: () => T): Promise<T>;

	private statement(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.database.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
}

class NodeSqliteTransaction extends NodeSqliteExecutor {
	private readonly scope: TransactionScope;

	constructor(database: DatabaseSync, statements: Map<string, StatementSync>, scope: TransactionScope) {
		super(database, statements);
		this.scope = scope;
	}

	protected async runOperation<T>(operation: () => T): Promise<T> {
		if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
		return operation();
	}
}

/** 由 Node 内置 `node:sqlite` 支持的 `SqliteDatabase` 适配器。 */
export class NodeSqliteDatabase extends NodeSqliteExecutor implements SqliteDatabase {
	private readonly access = new SerialOperationQueue();
	private closed = false;

	constructor(database: DatabaseSync) {
		super(database, new Map());
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.access.runAsync(async () => {
			this.database.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new NodeSqliteTransaction(this.database, this.statements, scope));
				scope.active = false;
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}

	close(): Promise<void> {
		return this.access.run(() => {
			if (this.closed) return;
			this.closed = true;
			this.statements.clear();
			try {
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close();
			}
		});
	}

	protected runOperation<T>(operation: () => T): Promise<T> {
		return this.access.run(operation);
	}
}

/** 打开并配置由 Node 支持的 SQLite 数据库门面。 */
export async function openNodeSqliteDatabase(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<NodeSqliteDatabase> {
	const checkpointPages = options.walAutoCheckpointPages ?? DEFAULT_WAL_AUTO_CHECKPOINT_PAGES;
	const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
	if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
	const database = new DatabaseSync(path, { timeout });
	const adapter = new NodeSqliteDatabase(database);
	try {
		await adapter.exec("PRAGMA journal_mode = WAL");
		await adapter.exec("PRAGMA synchronous = NORMAL");
		await adapter.exec(`PRAGMA wal_autocheckpoint = ${checkpointPages}`);
		return adapter;
	} catch (error) {
		try {
			await adapter.close();
		} catch {
			// 保留配置失败的错误。
		}
		throw error;
	}
}

/** 使用 Node 内置 SQLite 打开或创建基于文件的持久存储。 */
export async function openNodeSqliteStorage(
	path: string,
	options: NodeSqliteStorageOptions = {},
): Promise<SqliteStorage> {
	return SqliteStorage.open(await openNodeSqliteDatabase(path, options));
}
