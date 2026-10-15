import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * RPC 模式测试。
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN)("RPC mode", () => {
	let client: RpcClient;
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = join(tmpdir(), `pi-rpc-test-${Date.now()}`);
		client = new RpcClient({
			cliPath: join(__dirname, "..", "dist", "cli.js"),
			cwd: join(__dirname, ".."),
			env: { PI_CODING_AGENT_DIR: sessionDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	afterEach(async () => {
		await client.stop();
		if (sessionDir && existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true });
		}
	});

	test("should get state", async () => {
		await client.start();
		const state = await client.getState();

		expect(state.model).toBeDefined();
		expect(state.model?.provider).toBe("anthropic");
		expect(state.model?.id).toBe("claude-sonnet-4-5");
		expect(state.isStreaming).toBe(false);
		expect(state.messageCount).toBe(0);
	}, 30000);

	test("should save messages to session file", async () => {
		await client.start();

		// 发送提示词并等待完成。
		const events = await client.promptAndWait("Reply with just the word 'hello'");

		// 应包含消息事件。
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThanOrEqual(2); // user + assistant

		// 等待文件写入完成。
		await new Promise((resolve) => setTimeout(resolve, 200));

		// 验证会话文件。
		const sessionsPath = join(sessionDir, "sessions");
		expect(existsSync(sessionsPath)).toBe(true);

		const sessionDirs = readdirSync(sessionsPath);
		expect(sessionDirs.length).toBeGreaterThan(0);

		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		expect(sessionFiles.length).toBe(1);

		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		// 第一项应为会话头。
		expect(entries[0].type).toBe("session");

		// 应包含用户消息和 assistant 消息。
		const messages = entries.filter((e: { type: string }) => e.type === "message");
		expect(messages.length).toBeGreaterThanOrEqual(2);

		const roles = messages.map((m: { message: { role: string } }) => m.message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	}, 90000);

	test("should handle manual compaction", async () => {
		await client.start();

		// 先发送提示词，生成待压缩的消息。
		await client.promptAndWait("Say hello");

		// 执行压缩。
		const result = await client.compact();
		expect(result.summary).toBeDefined();
		expect(result.tokensBefore).toBeGreaterThan(0);

		// 等待文件写入完成。
		await new Promise((resolve) => setTimeout(resolve, 200));

		// 验证会话文件中的压缩记录。
		const sessionsPath = join(sessionDir, "sessions");
		const sessionDirs = readdirSync(sessionsPath);
		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const compactionEntries = entries.filter((e: { type: string }) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);
		expect(compactionEntries[0].summary).toBeDefined();
	}, 120000);

	test("should execute bash command", async () => {
		await client.start();

		const result = await client.bash("echo hello");
		expect(result.output.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
	}, 30000);

	test("should add bash output to context", async () => {
		await client.start();

		// 先发送提示词以初始化会话。
		await client.promptAndWait("Say hi");

		// 运行 bash 命令。
		const uniqueValue = `test-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		// 等待文件写入完成。
		await new Promise((resolve) => setTimeout(resolve, 200));

		// 验证会话中的 bash 消息。
		const sessionsPath = join(sessionDir, "sessions");
		const sessionDirs = readdirSync(sessionsPath);
		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const bashMessages = entries.filter(
			(e: { type: string; message?: { role: string } }) =>
				e.type === "message" && e.message?.role === "bashExecution",
		);
		expect(bashMessages.length).toBe(1);
		expect(bashMessages[0].message.output).toContain(uniqueValue);
	}, 90000);

	test("should include bash output in LLM context", async () => {
		await client.start();

		// 运行 bash 命令并输出唯一值。
		const uniqueValue = `unique-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		// 询问 LLM 命令输出的内容。
		const events = await client.promptAndWait(
			"What was the exact output of the echo command I just ran? Reply with just the value, nothing else.",
		);

		// 查找 assistant 的响应。
		const messageEndEvents = events.filter((e) => e.type === "message_end") as AgentEvent[];
		const assistantMessage = messageEndEvents.find(
			(e) => e.type === "message_end" && e.message?.role === "assistant",
		) as any;

		expect(assistantMessage).toBeDefined();

		const textContent = assistantMessage.message.content.find((c: any) => c.type === "text");
		expect(textContent?.text).toContain(uniqueValue);
	}, 90000);

	test("should set and get thinking level", async () => {
		await client.start();

		// 设置思考等级。
		await client.setThinkingLevel("high");

		// 通过状态验证。
		const state = await client.getState();
		expect(state.thinkingLevel).toBe("high");
	}, 30000);

	test("should cycle thinking level", async () => {
		await client.start();

		// 获取初始等级。
		const initialState = await client.getState();
		const initialLevel = initialState.thinkingLevel;

		// 循环切换。
		const result = await client.cycleThinkingLevel();
		expect(result).toBeDefined();
		expect(result!.level).not.toBe(initialLevel);

		// 通过状态验证。
		const newState = await client.getState();
		expect(newState.thinkingLevel).toBe(result!.level);
	}, 30000);

	test("should get available thinking levels", async () => {
		await client.start();

		const levels = await client.getAvailableThinkingLevels();
		expect(levels.length).toBeGreaterThan(0);

		// get_state 返回的当前等级必须包含在可用等级列表中。
		const state = await client.getState();
		expect(levels).toContain(state.thinkingLevel);

		// cycle_thinking_level 只能切换到 get_available_thinking_levels 返回的等级。
		const initialLevel = state.thinkingLevel;
		const cycled = await client.cycleThinkingLevel();
		if (cycled) {
			expect(levels).toContain(cycled.level);
			// 除非只有一个等级，否则每次循环都应切换到不同等级。
			if (levels.length > 1) {
				expect(cycled.level).not.toBe(initialLevel);
			}
		}
	}, 30000);

	test("should get available models", async () => {
		await client.start();

		const models = await client.getAvailableModels();
		expect(models.length).toBeGreaterThan(0);

		// 所有模型都应包含必需字段。
		for (const model of models) {
			expect(model.provider).toBeDefined();
			expect(model.id).toBeDefined();
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(typeof model.reasoning).toBe("boolean");
		}
	}, 30000);

	test("should get session stats", async () => {
		await client.start();

		// 先发送提示词。
		await client.promptAndWait("Hello");

		const stats = await client.getSessionStats();
		expect(stats.sessionFile).toBeDefined();
		expect(stats.sessionId).toBeDefined();
		expect(stats.userMessages).toBeGreaterThanOrEqual(1);
		expect(stats.assistantMessages).toBeGreaterThanOrEqual(1);
	}, 90000);

	test("should create new session", async () => {
		await client.start();

		// 发送提示词。
		await client.promptAndWait("Hello");

		// 验证消息存在。
		let state = await client.getState();
		expect(state.messageCount).toBeGreaterThan(0);

		// 新建会话。
		await client.newSession();

		// 验证消息已清空。
		state = await client.getState();
		expect(state.messageCount).toBe(0);
	}, 90000);

	test("should export to HTML", async () => {
		await client.start();

		// 先发送提示词。
		await client.promptAndWait("Hello");

		// 导出。
		const result = await client.exportHtml();
		expect(result.path).toBeDefined();
		expect(result.path.endsWith(".html")).toBe(true);
		expect(existsSync(result.path)).toBe(true);
	}, 90000);

	test("should get last assistant text", async () => {
		await client.start();

		// 初始值为 null。
		let text = await client.getLastAssistantText();
		expect(text).toBeUndefined();

		// 发送提示词。
		await client.promptAndWait("Reply with just: test123");

		// 此时应已有文本。
		text = await client.getLastAssistantText();
		expect(text).toContain("test123");
	}, 90000);

	test("should get session entries with since cursor", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");

		const { entries, leafId } = await client.getEntries();
		expect(entries.length).toBeGreaterThanOrEqual(2); // user + assistant
		for (const entry of entries) {
			expect(entry.id).toBeDefined();
		}
		expect(leafId).toBe(entries[entries.length - 1].id);

		// cursor 只返回指定 ID 之后的条目。
		const since = await client.getEntries(entries[0].id);
		expect(since.entries.map((e) => e.id)).toEqual(entries.slice(1).map((e) => e.id));
		expect(since.leafId).toBe(leafId);

		// 未知的 since ID 会返回错误响应。
		await expect(client.getEntries("nonexistent-id")).rejects.toThrow("Entry not found");
	}, 90000);

	test("should get session tree", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");

		const { entries, leafId } = await client.getEntries();
		const { tree, leafId: treeLeafId } = await client.getTree();
		expect(treeLeafId).toBe(leafId);

		// 单个根节点，其链条应与这些条目相符。
		expect(tree.length).toBe(1);
		const chainIds: string[] = [];
		let nodes = tree;
		while (nodes.length === 1) {
			chainIds.push(nodes[0].entry.id);
			nodes = nodes[0].children;
		}
		expect(nodes.length).toBe(0);
		expect(chainIds).toEqual(entries.map((e) => e.id));
	}, 90000);

	test("should retain pre-compaction entries in get_entries", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");
		const before = await client.getEntries();

		await client.compact();

		const after = await client.getEntries();
		// 仅追加：压缩前的条目仍然保留，且顺序不变。
		expect(after.entries.slice(0, before.entries.length).map((e) => e.id)).toEqual(before.entries.map((e) => e.id));
		expect(after.entries.some((e) => e.type === "compaction")).toBe(true);
	}, 120000);

	test("should set and get session name", async () => {
		await client.start();

		// 初始值为 undefined。
		let state = await client.getState();
		expect(state.sessionName).toBeUndefined();

		// 先发送提示词：会话文件只会在第一条 assistant 消息之后写入。
		await client.promptAndWait("Reply with just 'ok'");

		// 设置名称。
		await client.setSessionName("my-test-session");

		// 通过状态验证。
		state = await client.getState();
		expect(state.sessionName).toBe("my-test-session");

		// 等待文件写入完成。
		await new Promise((resolve) => setTimeout(resolve, 200));

		// 验证会话文件中的 session_info 条目。
		const sessionsPath = join(sessionDir, "sessions");
		const sessionDirs = readdirSync(sessionsPath);
		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const sessionInfoEntries = entries.filter((e: { type: string }) => e.type === "session_info");
		expect(sessionInfoEntries.length).toBe(1);
		expect(sessionInfoEntries[0].name).toBe("my-test-session");
	}, 60000);
});
