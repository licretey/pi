import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createMcpExtension } from "../../../src/extensions/mcp/index.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness } from "../harness.ts";

const mcpExtension = createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) });

describe("MCP tool renderers", () => {
	// #10285 回归测试：恢复会话时，即使 MCP 服务器尚未连接，也会渲染工具调用，前提是
	// 它们仍使用 MCP 渲染器进行渲染，而不会像其他情况那样使用展开后的回退渲染器。
	it("renders calls to MCP tools that are not registered", async () => {
		initTheme("dark");
		const harness = await createHarness({ extensionFactories: [mcpExtension] });
		try {
			const resolve = (toolName: string) =>
				harness.session.extensionRunner.resolveToolRenderers(toolName, () =>
					harness.session.getToolDefinition(toolName),
				);

			const call = resolve("mcp__my_docs__search")?.renderCall?.({ query: "pi" }, theme, {
				expanded: false,
			} as unknown as ToolRenderContext);
			expect(stripAnsi(call?.render(100).join("\n") ?? "")).toContain('my_docs/search query="pi"');
			expect(resolve("not_mcp")).toBeUndefined();
			// 已注册的工具继续使用各自的渲染器。
			expect(resolve("read")?.renderCall).toBe(harness.session.getToolDefinition("read")?.renderCall);
		} finally {
			harness.cleanup();
		}
	});

	it("renders them in HTML exports too", async () => {
		initTheme("dark");
		const dir = mkdtempSync(join(tmpdir(), "pi-10285-"));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		const harness = await createHarness({ extensionFactories: [mcpExtension], sessionManager });
		try {
			sessionManager.appendMessage({ role: "user", content: "search", timestamp: 1 });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "mcp__my_docs__search", arguments: { query: "pi" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			});

			const html = readFileSync(await harness.session.exportToHtml(join(dir, "export.html")), "utf8");
			const data = /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
			const session = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
			expect(stripAnsi(session.renderedTools?.["call-1"]?.callHtml ?? "")).toContain("my_docs/search");
		} finally {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
