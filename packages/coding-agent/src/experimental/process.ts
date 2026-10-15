import { type ChildProcess, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPackageDir, isBunBinary, isBundledNode } from "../config.ts";

export const INTERNAL_PROCESS_ENV = "__PI_INTERNAL_SPAWN";

export type InternalProcessRole = "coordinator" | "server" | "session-worker";

/** 检测直接执行的源码模块或未打包的内部进程模块。 */
export function isDirectInternalProcessEntry(moduleUrl: string): boolean {
	return (
		!isBunBinary &&
		!isBundledNode &&
		process.argv[1] !== undefined &&
		resolve(process.argv[1]) === fileURLToPath(moduleUrl)
	);
}

/** 读取并校验内部进程角色，但不将其移除。 */
export function getInternalProcessRole(): InternalProcessRole | undefined {
	const role = process.env[INTERNAL_PROCESS_ENV];
	if (role === undefined) return undefined;
	if (role === "coordinator" || role === "server" || role === "session-worker") return role;
	throw new Error(`Unsupported internal process role: ${role}`);
}

/** 读取并校验角色后将其移除，避免后代进程继承该角色。 */
export function consumeInternalProcessRole(): InternalProcessRole | undefined {
	const role = getInternalProcessRole();
	delete process.env[INTERNAL_PROCESS_ENV];
	return role;
}

export interface InternalProcessSpawnOptions {
	readonly entryUrl?: URL;
	readonly env?: NodeJS.ProcessEnv;
}

/** 在 Node 和已编译的 Bun 环境中以一致方式启动由 Pi 管理的分离进程。 */
export function spawnInternalProcess(
	role: InternalProcessRole,
	args: readonly string[],
	options: InternalProcessSpawnOptions = {},
): ChildProcess {
	if (isBunBinary && options.entryUrl) {
		throw new Error("A compiled Bun executable cannot launch an external internal-process entrypoint");
	}
	const entryUrl = defaultEntryUrl(role, options.entryUrl);
	// --import 接收模块说明符；直接传入路径时，Windows 盘符以及路径中的 `#`、`?` 或 `%` 都会导致解析失败。
	const sourceRuntimeArgs = import.meta.url.endsWith(".ts")
		? ["--import", new URL("source-resolver.ts", import.meta.url).href]
		: [];
	const child = spawn(
		process.execPath,
		isBunBinary ? [...args] : [...sourceRuntimeArgs, fileURLToPath(entryUrl), ...args],
		{
			cwd: process.cwd(),
			detached: true,
			env: {
				...process.env,
				...options.env,
				[INTERNAL_PROCESS_ENV]: role,
			},
			stdio: "ignore",
			windowsHide: true,
		},
	);
	child.unref();
	return child;
}

/** 强制已启动的内部进程退出，并等待其不再拥有资源。 */
export async function terminateInternalProcess(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const terminated = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
	child.kill("SIGKILL");
	await terminated;
}

function defaultEntryUrl(role: InternalProcessRole, override: URL | undefined): URL {
	if (override) return override;
	if (isBundledNode) {
		const entry = role === "coordinator" ? "coordinator.js" : "cli.js";
		return pathToFileURL(join(getPackageDir(), "dist", "bundle", entry));
	}
	const javaScript = import.meta.url.endsWith(".js");
	if (role === "coordinator") {
		return new URL(javaScript ? "coordinator.js" : "coordinator.ts", import.meta.url);
	}
	if (role === "server") {
		return new URL(javaScript ? "server.js" : "server.ts", import.meta.url);
	}
	return new URL(javaScript ? "session-worker.js" : "session-worker.ts", import.meta.url);
}

export const MAX_CONTROL_LINE_BYTES = 128 * 1024 * 1024;

export function encodeControlLine(message: unknown): string {
	const line = `${JSON.stringify(message)}\n`;
	if (Buffer.byteLength(line) > MAX_CONTROL_LINE_BYTES) throw new Error("Internal control message is too large");
	return line;
}
