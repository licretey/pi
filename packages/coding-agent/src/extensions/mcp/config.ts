/**
 * MCP 服务器配置。
 *
 * 从智能体目录中的 `mcp.json` 读取服务器配置；对于受信任的项目，也会从
 * `<project>/.pi/mcp.json` 读取。两种文件都采用其他 MCP 客户端共用的 `mcpServers` 格式，因此
 * 可以直接复用现有配置。项目配置中的条目会替换同名的全局配置。
 *
 *
 * 项目配置中的条目如果没有 `command`、`url` 或 `type`，则只覆盖全局同名服务器的 `enabled`、`exposure` 和
 * `toolExposure`，例如在某个项目中禁用该服务器：
 * `{ "mcpServers": { "internal-tools": { "enabled": false } } }`。全局条目的其他配置会保留，
 * 包括项目自身无法设置的凭据。
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * 未配置 `Authorization` 请求头的 HTTP 服务器在返回 401 时会使用 OAuth（通过 `/mcp` 登录）。
 * `"auth": { "provider": "<provider>" }` 则会改用 `/login` 提供商的令牌。项目配置文件
 * 不能使用此选项，因此仓库无法指定凭据的发送目标。
 *
 * 顶层配置 `autoEnableCodemode`（默认值为 true）会在服务器连接且
 * 暴露方式为 `codemode` 时激活 codemode 工具。项目中的设置会覆盖全局设置。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import {
	type McpExposure,
	type McpServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "../../core/mcp-servers.ts";

export type {
	McpExposure,
	McpHttpServerConfig,
	McpOAuthConfig,
	McpServerConfig,
	McpStdioServerConfig,
} from "../../core/mcp-servers.ts";
export { getMcpToolExposure } from "../../core/mcp-servers.ts";

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** 定义此条目的配置文件路径，或注册此条目的扩展路径。 */
	source: string;
	/**
	 * 对于全局或项目的 `mcp.json`，值为对应配置范围；通过
	 * `pi.registerMcpServer()` 注册的服务器，值为 `extension`。扩展服务器的变更不会保存。
	 */
	scope?: "global" | "project" | "extension";
	/** 覆盖此全局服务器 `enabled`、`exposure` 或 `toolExposure` 设置的项目 `mcp.json` 路径。 */
	override?: string;
}

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	/** `codemode` 服务器连接时是否激活 codemode 工具。默认值：true。 */
	autoEnableCodemode?: boolean;
	errors: string[];
	/** 项目受信任时使用的项目 `mcp.json` 路径，`/mcp` 会将项目覆盖项保存到此文件。 */
	projectConfig?: string;
}

const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/** 判断此条目是否用于覆盖其他位置定义的服务器，而非定义新服务器。 */
function isOverride(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface McpConfigState {
	servers: Map<string, McpServerEntry>;
	autoEnableCodemode?: boolean;
	errors: string[];
}

function readConfigFile(path: string, scope: "global" | "project", state: McpConfigState): void {
	const { servers, errors } = state;
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	if (typeof parsed.autoEnableCodemode === "boolean") state.autoEnableCodemode = parsed.autoEnableCodemode;
	else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		if (scope === "project" && isRecord(value) && isOverride(value)) {
			const base = servers.get(name);
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
			if (!base) {
				errors.push(`${path}: server "${name}" needs "command" or "url", or a global server to override`);
			} else if (extra.length > 0) {
				errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
			} else {
				const config = validateMcpServerConfig(name, { ...base.config, ...value });
				if (typeof config === "string") errors.push(`${path}: ${config}`);
				else servers.set(name, { ...base, config, override: path });
			}
			continue;
		}
		const config = validateMcpServerConfig(name, value);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		// 仅 `-` 和 `_` 不同的名称会映射到相同命名空间。
		const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
		if (clash) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (scope === "project" && "url" in config && config.auth) {
			errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
			continue;
		}
		servers.set(name, { name, config, source: path, scope });
	}
}

/**
 * 加载全局 MCP 配置，以及受信任时的项目 MCP 配置。已禁用的服务器也会包含在结果中，并标记
 * 为 `enabled: false`，以便之后重新启用。
 */
export function loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig {
	const state: McpConfigState = { servers: new Map(), errors: [] };
	readConfigFile(join(options.agentDir, "mcp.json"), "global", state);
	const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
	if (projectConfig) readConfigFile(projectConfig, "project", state);
	return {
		servers: [...state.servers.values()],
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
		errors: state.errors,
		...(projectConfig ? { projectConfig } : {}),
	};
}

/** `/mcp` 命令修改的设置。`enabled: true` 和 `exposure: "codemode"` 是默认值，写入时会删除对应键。 */
export interface McpServerConfigPatch {
	enabled?: boolean;
	exposure?: McpExposure;
}

/**
 * 在定义或覆盖该服务器的 `mcp.json` 中修改其设置。启用 `override` 时，若条目不存在，
 * 会新增一个覆盖项。覆盖项需要保留默认值，因为它会替换全局
 * 服务器配置。文件中的其他内容会保留，重写时也会沿用原有缩进。
 */
export function updateMcpServerConfig(
	path: string,
	name: string,
	patch: McpServerConfigPatch,
	options: { override?: boolean } = {},
): void {
	editMcpServers(path, (servers, parsed) => {
		let server = servers?.[name];
		if (server === undefined && options.override) {
			server = {};
			parsed.mcpServers = { ...servers, [name]: server };
		}
		if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
		const keepDefaults = isOverride(server);
		if (patch.enabled !== undefined) {
			if (patch.enabled && !keepDefaults) delete server.enabled;
			else server.enabled = patch.enabled;
		}
		if (patch.exposure !== undefined) {
			if (patch.exposure === "codemode" && !keepDefaults) delete server.exposure;
			else server.exposure = patch.exposure;
		}
		return true;
	});
}

/**
 * 向 `mcp.json` 添加服务器；文件不存在时会创建。如果已有同名条目，
 * 则替换该条目。替换了现有条目时返回 true。
 */
export function addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean {
	let replaced = false;
	editMcpServers(path, (servers, parsed) => {
		const target = servers ?? {};
		replaced = target[name] !== undefined;
		target[name] = config;
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}

/** 从 `mcp.json` 中移除服务器。如果文件中没有该服务器，则返回 false。 */
export function removeMcpServerConfig(path: string, name: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	editMcpServers(path, (servers) => {
		if (!servers || servers[name] === undefined) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}

/**
 * 读取 `mcp.json`（文件不存在时使用空配置），让 `edit` 修改其中的 `mcpServers`；当
 * `edit` 返回 true 时，按原缩进写回文件。其他内容会保留。
 */
function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
	const parsed: unknown = text === undefined ? {} : JSON.parse(text);
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		throw new Error(`${path}: expected an object with an "mcpServers" object`);
	}
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	if (!edit(servers, parsed)) return;
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(parsed, null, indent)}\n`);
}
