import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 由服务器托管的一个会话：目录中包含 `meta.json` 和由工作进程管理的 `session.sqlite`。 */
export interface SessionCatalogMetadata {
	readonly id: string;
	readonly createdAt: number;
	/** 会话代理运行时使用的工作目录。 */
	readonly cwd: string;
	/** 会话目录。工作进程会锁定该目录并管理其中的存储。 */
	readonly path: string;
}

const METADATA_FILE = "meta.json";
const STORAGE_FILE = "session.sqlite";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSessionId(id: string): boolean {
	return SESSION_ID.test(id);
}

/** 会话的持久化存储文件，仅由该会话的工作进程打开。 */
export function sessionStoragePath(metadata: SessionCatalogMetadata): string {
	return join(metadata.path, STORAGE_FILE);
}

/** 目录中的所有会话；缺少有效元数据的条目会被跳过。 */
export async function listSessions(sessionDir: string): Promise<SessionCatalogMetadata[]> {
	let names: string[];
	try {
		names = await readdir(sessionDir);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const sessions = await Promise.all(names.filter(isSessionId).map((name) => readSession(sessionDir, name)));
	return sessions.filter((metadata) => metadata !== undefined);
}

/** 根据 ID 获取会话；会话不存在时返回 undefined。 */
export async function readSession(sessionDir: string, id: string): Promise<SessionCatalogMetadata | undefined> {
	if (!isSessionId(id)) return undefined;
	const path = join(sessionDir, id);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(join(path, METADATA_FILE), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { createdAt, cwd } = value as { createdAt?: unknown; cwd?: unknown };
	if (typeof createdAt !== "number" || typeof cwd !== "string") return undefined;
	return { id, createdAt, cwd, path };
}

/** 创建空会话；其工作进程首次打开时会创建存储。 */
export async function createSession(
	sessionDir: string,
	options: { readonly id?: string; readonly cwd: string },
): Promise<SessionCatalogMetadata> {
	const id = options.id ?? randomUUID();
	if (!isSessionId(id)) throw new Error(`Invalid session ID: ${id}`);
	const path = join(sessionDir, id);
	await mkdir(sessionDir, { recursive: true });
	try {
		await mkdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Session ${id} already exists`);
		throw error;
	}
	const metadata: SessionCatalogMetadata = { id, createdAt: Date.now(), cwd: options.cwd, path };
	await writeFile(
		join(path, METADATA_FILE),
		`${JSON.stringify({ createdAt: metadata.createdAt, cwd: metadata.cwd }, null, "\t")}\n`,
	);
	return metadata;
}

/** 删除会话目录；必须先关闭对应的工作进程。 */
export async function deleteSession(metadata: SessionCatalogMetadata): Promise<void> {
	await rm(metadata.path, { recursive: true, force: true });
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
