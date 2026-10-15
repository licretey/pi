/**
 * 将 MCP 服务器通过 `notifications/message` 发送的日志消息追加到 Agent 目录下的 `mcp.log`。
 * 多个 pi 进程可能同时写入，因此每条消息都通过一次同步追加完成。文件超过 `MAX_LOG_BYTES` 后会轮转为 `mcp.log.1`。
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatData(data: unknown): string {
	if (typeof data === "string") return data;
	try {
		return JSON.stringify(data) ?? String(data);
	} catch {
		return String(data);
	}
}

/** 将 `server` 发来的一条 `notifications/message` 格式化为日志行，并缩进后续行。 */
export function formatMcpLogMessage(server: string, params: unknown, now: Date = new Date()): string {
	const message = isRecord(params) ? params : { data: params };
	const level = typeof message.level === "string" ? message.level : "info";
	const logger = typeof message.logger === "string" && message.logger ? ` ${message.logger}:` : "";
	const text = formatData(message.data).replace(/\r?\n/g, "\n    ");
	return `${now.toISOString()} [${server}] ${level}${logger} ${text}\n`;
}

/** 将服务器日志消息追加到单个文件。写入错误会被忽略，避免日志功能影响工具运行。 */
export class McpServerLog {
	readonly path: string;
	private size: number | undefined;

	constructor(path: string) {
		this.path = path;
	}

	write(server: string, params: unknown): void {
		const line = formatMcpLogMessage(server, params);
		try {
			if (this.size === undefined) {
				mkdirSync(dirname(this.path), { recursive: true });
				this.size = this.currentSize();
			}
			if (this.size > MAX_LOG_BYTES) {
				// 其他进程可能已轮转文件，因此重命名前再次检查大小。
				if (this.currentSize() > MAX_LOG_BYTES) renameSync(this.path, `${this.path}.1`);
				this.size = this.currentSize();
			}
			appendFileSync(this.path, line);
			this.size += Buffer.byteLength(line);
		} catch {
			// 忽略错误：日志写入仅尽力完成。
		}
	}

	private currentSize(): number {
		try {
			return statSync(this.path).size;
		} catch {
			return 0;
		}
	}
}
