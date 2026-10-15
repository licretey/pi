import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";

const connection = new Connection({ command: [daemon] });
afterAll(() => connection.close());

const windows = process.platform === "win32";
const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");

registerEnvConformance(
	{ describe, expect, it },
	"RemoteExecutionEnv over a pipe",
	async (use) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-env-conformance-"));
		try {
			await use(new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd, watch: { pollIntervalMs: 100 } }));
		} finally {
			// 在 Windows 上，被结束命令的进程可能会短暂占用目录。
			rmSync(cwd, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
		}
	},
	// 除非启用了原生符号链接，否则 Git Bash 的 `ln -s` 会复制文件而不是创建链接。
	windows ? { shell: [gitBash, "-c"], symlinks: false } : {},
);
