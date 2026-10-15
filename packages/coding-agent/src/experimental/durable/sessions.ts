import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";

/** 保存 `session.sqlite` 并由当前进程锁定的会话目录。 */
export interface SessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

/** 为 `cwd` 创建的新会话；若指定 `continueSession`，则使用该目录下最新的会话。 */
export async function selectSession(cwdInput: string, continueSession: boolean): Promise<SessionLocation> {
	const cwd = await realpath(resolve(cwdInput));
	const root = join(
		getAgentDir(),
		"experimental",
		"durable-sessions",
		createHash("sha256").update(cwd).digest("hex").slice(0, 24),
	);
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (continueSession) {
		const entries = await readdir(root, { withFileTypes: true });
		const newest = entries
			.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.at(-1);
		if (!newest) throw new Error(`No durable session exists for ${cwd}`);
		directory = join(root, newest);
	} else {
		directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
		await mkdir(directory);
		created = true;
	}

	let release: () => Promise<void>;
	try {
		// 崩溃进程遗留的锁会在 10 秒后过期；放弃前等待这段时间。
		release = await lockfile.lock(directory, {
			realpath: false,
			retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
		});
	} catch (error) {
		throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
	}
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd, created, release };
}
