import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 测试运行所需的守护进程：优先使用 `PI_ENV_DAEMON`（CI 会将其指向发布构建）；否则使用 `cargo build` 在
 * ../daemon 目录中构建。
 */
export const daemon =
	process.env.PI_ENV_DAEMON ??
	resolve(import.meta.dirname, `../daemon/target/debug/pi-env${process.platform === "win32" ? ".exe" : ""}`);
if (!existsSync(daemon)) {
	throw new Error(`Build the daemon first: npm run build:daemon in packages/env (missing ${daemon})`);
}
