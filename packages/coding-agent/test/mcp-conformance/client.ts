/**
 * 官方 MCP 客户端一致性测试套件的被测客户端。该套件会启动场景服务器，
 * 并以服务器 URL 作为最后一个参数运行此脚本，将场景名称放入
 * `MCP_CONFORMANCE_SCENARIO`，场景数据则放入 `MCP_CONFORMANCE_CONTEXT`。
 *
 * 此脚本会驱动 pi 处理 `mcp.json` HTTP 服务器时使用的代码：`McpServerConnection` 负责连接并调用
 * 工具，`signInMcpServer` 则执行 `/mcp` 启动的 OAuth 登录流程。浏览器行为由脚本模拟：获取授权 URL 时
 * 不跟随重定向，再将重定向请求发送到 pi 的本地回环回调服务器。凭据仅保存在内存中。
 *
 * 通过 run.ts 执行；该脚本会将结果写入 `PI_MCP_CONFORMANCE_REPORT`。
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import type { McpHttpServerConfig, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import type { McpSignInPrompt } from "../../src/extensions/mcp/oauth.ts";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
	signInMcpServer,
} from "../../src/extensions/mcp/runtime.ts";

/**
 * pi 请求用户登录的次数没有上限，因此如果用户不断批准，而服务器始终不接受已授予的权限范围，流程就会无限循环。
 * 此处模拟的用户最多批准三次，与 `auth/scope-retry-limit` 检查的上限一致。
 */
const MAX_SIGN_INS = 3;
const REQUEST_TIMEOUT_SECONDS = 20;

interface ToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** 场景连接后的工具调用；对于此客户端未知的场景，值为 `undefined`。 */
function toolCalls(scenario: string, connection: McpServerConnection): ToolCall[] | undefined {
	if (scenario.startsWith("auth/")) return [{ name: "test-tool", arguments: {} }];
	switch (scenario) {
		case "initialize":
			return [];
		case "tools_call":
			return [{ name: "add_numbers", arguments: { a: 2, b: 3 } }];
		case "sse-retry":
			return [{ name: "test_reconnection", arguments: {} }];
		case "elicitation-sep1034-client-defaults":
			return [{ name: "test_client_elicitation_defaults", arguments: {} }];
		case "json-schema-2020-12-preservation": {
			// 服务器会将回显的架构与先前列出的架构比较，以检测是否有关键字丢失。
			const tool = connection.tools.find((candidate) => candidate.name === "json_schema_2020_12_tool");
			if (!tool) throw new Error("json_schema_2020_12_tool was not listed");
			return [{ name: "json_schema_echo", arguments: { schema: tool.inputSchema } }];
		}
		default:
			return undefined;
	}
}

function log(message: string): void {
	process.stderr.write(`[pi-conformance] ${message}\n`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readContext(): Record<string, unknown> {
	const raw = process.env.MCP_CONFORMANCE_CONTEXT;
	if (!raw) return {};
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("MCP_CONFORMANCE_CONTEXT is not an object");
	}
	return parsed as Record<string, unknown>;
}

function isLoopback(url: URL): boolean {
	return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** 用户立即批准时，浏览器对授权 URL 的处理方式。 */
async function visitAuthorizationUrl(url: URL): Promise<void> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	if (!location) throw new Error(`Authorization endpoint answered ${response.status} without a redirect`);
	const callback = new URL(location, url);
	if (callback.protocol !== "http:" || !isLoopback(callback)) {
		throw new Error(`Authorization endpoint redirected to ${callback.origin}, not to the loopback callback`);
	}
	log(`delivering authorization response to ${callback.origin}${callback.pathname}`);
	await (await fetch(callback)).text();
}

function simulatedBrowser(): McpSignInPrompt {
	let visit: Promise<void> | undefined;
	return {
		showAuthorizationUrl(url) {
			log(`authorization URL: ${url.origin}${url.pathname}`);
			visit = visitAuthorizationUrl(url);
		},
		async promptForRedirectUrl(signal) {
			try {
				await visit;
			} catch (error) {
				// 取消登录，而不是等待永远不会到来的回调。
				log(`browser failed: ${errorMessage(error)}`);
				return undefined;
			}
			if (!signal.aborted) {
				await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			}
			return undefined;
		},
	};
}

async function run(serverUrl: string, scenario: string): Promise<void> {
	const context = readContext();
	const config: McpHttpServerConfig = { url: serverUrl, timeout: REQUEST_TIMEOUT_SECONDS };
	if (typeof context.client_id === "string") {
		// 预注册客户端在 `mcp.json` 中配置。
		config.oauth = {
			clientId: context.client_id,
			clientSecret: typeof context.client_secret === "string" ? context.client_secret : undefined,
		};
	}
	const entry: McpServerEntry = { name: "conformance", config, source: "conformance" };
	const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
	const connection = new McpServerConnection({
		entry,
		cwd: tmpdir(),
		createTransport: createDefaultTransport,
		credentials,
		onTools: () => {},
	});

	let signIns = 0;
	/** 运行 `operation`；服务器每次要求认证时，都模拟用户响应 `/mcp` 登录。 */
	const withSignIn = async <T>(operation: () => Promise<T>): Promise<T> => {
		for (;;) {
			try {
				return await operation();
			} catch (error) {
				const url = connection.oauthUrl;
				if (connection.state !== "needs-auth" || !url) throw error;
				if (signIns >= MAX_SIGN_INS) throw new Error(`Still requires sign-in after ${signIns} sign-ins`);
				signIns++;
				log(`sign-in ${signIns}${connection.challenge?.scope ? ` (scope: ${connection.challenge.scope})` : ""}`);
				await signInMcpServer({
					serverUrl: url,
					store: credentials.forServer(entry.name, url),
					settings: connection.oauthSettings(),
					challenge: connection.challenge,
					prompt: simulatedBrowser(),
				});
				connection.challenge = undefined;
			}
		}
	};

	try {
		await withSignIn(() => connection.getClient());
		log(`connected, tools: ${connection.tools.map((tool) => tool.name).join(", ") || "(none)"}`);
		const calls = toolCalls(scenario, connection);
		if (!calls) throw new Error(`Unknown scenario ${scenario}`);
		for (const call of calls) {
			const result = await withSignIn(() => connection.callTool(call.name, call.arguments, {}));
			log(`${call.name}: ${JSON.stringify(result.content)}`);
			if (result.isError) throw new Error(`Tool ${call.name} failed: ${JSON.stringify(result.content)}`);
		}
	} finally {
		await connection.close();
	}
}

async function main(): Promise<number> {
	const serverUrl = process.argv.at(-1);
	const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
	const reportPath = process.env.PI_MCP_CONFORMANCE_REPORT;
	let report: { success: boolean; error?: string };
	if (!serverUrl || !scenario || process.argv.length < 3) {
		report = { success: false, error: "Usage: MCP_CONFORMANCE_SCENARIO=<scenario> client.ts <server-url>" };
	} else {
		try {
			await run(serverUrl, scenario);
			report = { success: true };
		} catch (error) {
			report = { success: false, error: errorMessage(error) };
		}
	}
	if (report.error) log(`error: ${report.error}`);
	if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	return report.success ? 0 : 1;
}

// 显式退出：场景失败时，被测服务器的套接字可能仍处于打开状态。
process.exit(await main());
