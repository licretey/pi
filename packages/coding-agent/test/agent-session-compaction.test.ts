import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * 测试 AgentSession 的上下文压缩行为。
 *
 * 这些测试使用真实的 LLM 调用（不使用模拟）来验证：
 * - 手动压缩能够正常工作。
 * - 压缩过程中会话能够持久化。
 * - 压缩条目会保存到会话文件中。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodingTools } from "../src/index.ts";
import { API_KEY, createTestResourceLoader } from "./utilities.ts";

describe.skipIf(!API_KEY)("AgentSession compaction e2e", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		// 为会话文件创建临时目录
		tempDir = join(tmpdir(), `pi-compaction-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		// 跟踪事件。
		events = [];
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(inMemory = false) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => API_KEY,
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: createCodingTools(process.cwd()),
			},
		});

		sessionManager = inMemory ? SessionManager.inMemory() : SessionManager.create(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		// 将 keepRecentTokens 设为较小值，使短测试对话也能触发摘要
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		// 订阅事件以便跟踪
		session.subscribe((event) => {
			events.push(event);
		});

		return session;
	}

	it("should trigger manual compaction via compact()", async () => {
		await createSession();

		// 发送几个提示以积累对话历史
		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		// 手动压缩上下文
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		// 验证消息已压缩（应包含摘要和近期消息）。
		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		// 第一条消息应为摘要（包含摘要内容的用户消息）
		const firstMsg = messages[0];
		expect(firstMsg.role).toBe("compactionSummary");
	}, 120000);

	it("should maintain valid session state after compaction", async () => {
		await createSession();

		// 积累对话历史
		await session.prompt("What is the capital of France? One word answer.");
		await session.agent.waitForIdle();

		await session.prompt("What is the capital of Germany? One word answer.");
		await session.agent.waitForIdle();

		// 执行压缩。
		await session.compact();

		// 会话仍应可用
		await session.prompt("What is the capital of Italy? One word answer.");
		await session.agent.waitForIdle();

		// 压缩后应仍有消息
		expect(session.messages.length).toBeGreaterThan(0);

		// agent 应已作出回答
		const assistantMessages = session.messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);
	}, 180000);

	it("should persist compaction to session file", async () => {
		await createSession();

		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		await session.prompt("Say goodbye");
		await session.agent.waitForIdle();

		// 执行压缩。
		await session.compact();

		// 从会话管理器加载条目
		const entries = sessionManager.getEntries();

		// 应包含一条上下文压缩记录
		const compactionEntries = entries.filter((e) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);

		const compaction = compactionEntries[0];
		expect(compaction.type).toBe("compaction");
		if (compaction.type === "compaction") {
			expect(compaction.summary.length).toBeGreaterThan(0);
			expect(typeof compaction.firstKeptEntryId).toBe("string");
			expect(compaction.tokensBefore).toBeGreaterThan(0);
		}
	}, 120000);

	it("should work with --no-session mode (in-memory only)", async () => {
		await createSession(true); // in-memory mode

		// 发送提示。
		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		// 即使不持久化到文件，压缩也应正常工作
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);

		// 内存中的条目应包含压缩记录
		const entries = sessionManager.getEntries();
		const compactionEntries = entries.filter((e) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);
	}, 120000);

	it("should emit compaction events during manual compaction", async () => {
		await createSession();

		// 构建一些对话历史
		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		// 手动触发上下文压缩并检查事件
		await session.compact();

		const compactionEvents = events.filter((e) => e.type === "compaction_start" || e.type === "compaction_end");
		expect(compactionEvents).toHaveLength(2);
		expect(compactionEvents[0]).toEqual({ type: "compaction_start", reason: "manual" });
		expect(compactionEvents[1]).toMatchObject({
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
		});

		// 应已发出常规事件
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThan(0);
	}, 120000);
});
