/**
 * 测试 AgentSession 在生成分支摘要时的会话树导航。
 *
 * 这些测试验证：
 * - 导航到用户消息（根节点和非根节点）
 * - 导航到非用户消息
 * - 导航过程中生成分支摘要
 * - 将摘要附加到树中的正确位置
 * - 摘要生成过程中的中止处理
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_KEY, createTestSession, type TestSessionContext } from "./utilities.ts";

describe.skipIf(!API_KEY)("AgentSession tree navigation e2e", () => {
	let ctx: TestSessionContext;

	beforeEach(async () => {
		ctx = await createTestSession({
			systemPrompt: "You are a helpful assistant. Reply with just a few words.",
			settingsOverrides: { compaction: { keepRecentTokens: 1 } },
		});
	});

	afterEach(() => {
		ctx.cleanup();
	});

	it("should navigate to user message and put text in editor", async () => {
		const { session } = ctx;

		// 构造对话：u1 -> a1 -> u2 -> a2
		await session.prompt("First message");
		await session.agent.waitForIdle();
		await session.prompt("Second message");
		await session.agent.waitForIdle();

		// 获取树形条目
		const tree = session.sessionManager.getTree();
		expect(tree.length).toBe(1);

		// 查找第一条用户消息（u1）。
		const rootNode = tree[0];
		expect(rootNode.entry.type).toBe("message");

		// 导航到根用户消息，不生成摘要
		const result = await session.navigateTree(rootNode.entry.id, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("First message");

		// 导航到根用户消息后，叶节点应为 null（对话为空）
		expect(session.sessionManager.getLeafId()).toBeNull();
	}, 60000);

	it("should navigate to non-user message without editor text", async () => {
		const { session, sessionManager } = ctx;

		// 构建对话
		await session.prompt("Hello");
		await session.agent.waitForIdle();

		// 获取 assistant 消息
		const entries = sessionManager.getEntries();
		const assistantEntry = entries.find((e) => e.type === "message" && e.message.role === "assistant");
		expect(assistantEntry).toBeDefined();

		// 导航到 assistant 消息
		const result = await session.navigateTree(assistantEntry!.id, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBeUndefined();

		// 叶节点应为 assistant 条目
		expect(sessionManager.getLeafId()).toBe(assistantEntry!.id);
	}, 60000);

	it("should create branch summary when navigating with summarize=true", async () => {
		const { session, sessionManager } = ctx;

		// 构造对话：u1 -> a1 -> u2 -> a2
		await session.prompt("What is 2+2?");
		await session.agent.waitForIdle();
		await session.prompt("What is 3+3?");
		await session.agent.waitForIdle();

		// 获取对话树并查找第一条用户消息
		const tree = sessionManager.getTree();
		const rootNode = tree[0];

		// 导航到根用户消息并生成摘要
		const result = await session.navigateTree(rootNode.entry.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("What is 2+2?");
		expect(result.summaryEntry).toBeDefined();
		expect(result.summaryEntry?.type).toBe("branch_summary");
		expect(result.summaryEntry?.summary).toBeTruthy();
		expect(result.summaryEntry?.summary.length).toBeGreaterThan(0);

		// 已导航到根用户消息，因此摘要应为根条目（parentId = null）。
		expect(result.summaryEntry?.parentId).toBeNull();

		// 叶节点应为摘要条目
		expect(sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
	}, 120000);

	it("should attach summary to correct parent when navigating to nested user message", async () => {
		const { session, sessionManager } = ctx;

		// 构造对话：u1 -> a1 -> u2 -> a2 -> u3 -> a3
		await session.prompt("Message one");
		await session.agent.waitForIdle();
		await session.prompt("Message two");
		await session.agent.waitForIdle();
		await session.prompt("Message three");
		await session.agent.waitForIdle();

		// 获取第二条用户消息（u2）。
		const entries = sessionManager.getEntries();
		const userEntries = entries.filter((e) => e.type === "message" && e.message.role === "user");
		expect(userEntries.length).toBe(3);

		const u2 = userEntries[1];
		const a1 = entries.find((e) => e.id === u2.parentId); // a1 是 u2 的父条目。

		// 导航到 u2 并生成摘要。
		const result = await session.navigateTree(u2.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("Message two");
		expect(result.summaryEntry).toBeDefined();

		// 摘要应附加到 u2 的父条目 a1，因此 a1 现在有两个子项：u2 和摘要。
		expect(result.summaryEntry?.parentId).toBe(a1?.id);

		// 验证树结构
		const children = sessionManager.getChildren(a1!.id);
		expect(children.length).toBe(2);

		const childTypes = children.map((c) => c.type).sort();
		expect(childTypes).toContain("branch_summary");
		expect(childTypes).toContain("message");
	}, 120000);

	it("should attach summary to selected node when navigating to assistant message", async () => {
		const { session, sessionManager } = ctx;

		// 构造对话：u1 -> a1 -> u2 -> a2
		await session.prompt("Hello");
		await session.agent.waitForIdle();
		await session.prompt("Goodbye");
		await session.agent.waitForIdle();

		// 获取第一条助手消息（a1）。
		const entries = sessionManager.getEntries();
		const assistantEntries = entries.filter((e) => e.type === "message" && e.message.role === "assistant");
		const a1 = assistantEntries[0];

		// 导航到 a1 并生成摘要。
		const result = await session.navigateTree(a1.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBeUndefined(); // 助手消息没有编辑器文本。
		expect(result.summaryEntry).toBeDefined();

		// 摘要应附加到当前选中的节点 a1。
		expect(result.summaryEntry?.parentId).toBe(a1.id);

		// 叶节点应为摘要条目
		expect(sessionManager.getLeafId()).toBe(result.summaryEntry?.id);
	}, 120000);

	it("should handle abort during summarization", async () => {
		const { session, sessionManager } = ctx;

		// 构建对话
		await session.prompt("Tell me about something");
		await session.agent.waitForIdle();
		await session.prompt("Continue");
		await session.agent.waitForIdle();

		const entriesBefore = sessionManager.getEntries();
		const leafBefore = sessionManager.getLeafId();

		// 获取根用户消息
		const tree = sessionManager.getTree();
		const rootNode = tree[0];

		// 启动带摘要的导航，但立即中止
		const navigationPromise = session.navigateTree(rootNode.entry.id, { summarize: true });

		// 短暂延迟后中止（留出时间启动大语言模型调用）
		await new Promise((resolve) => setTimeout(resolve, 100));

		// 分支摘要生成期间，isCompacting 应为 true
		expect(session.isCompacting).toBe(true);

		session.abortBranchSummary();

		const result = await navigationPromise;

		expect(result.cancelled).toBe(true);
		expect(result.aborted).toBe(true);
		expect(result.summaryEntry).toBeUndefined();

		// 会话应保持不变
		const entriesAfter = sessionManager.getEntries();
		expect(entriesAfter.length).toBe(entriesBefore.length);
		expect(sessionManager.getLeafId()).toBe(leafBefore);
	}, 60000);

	it("should not create summary when navigating without summarize option", async () => {
		const { session, sessionManager } = ctx;

		// 构建对话
		await session.prompt("First");
		await session.agent.waitForIdle();
		await session.prompt("Second");
		await session.agent.waitForIdle();

		const entriesBefore = sessionManager.getEntries().length;

		// 不生成摘要，直接导航
		const tree = sessionManager.getTree();
		await session.navigateTree(tree[0].entry.id, { summarize: false });

		// 不应创建新条目
		const entriesAfter = sessionManager.getEntries().length;
		expect(entriesAfter).toBe(entriesBefore);

		// 不包含 branch_summary 条目。
		const summaries = sessionManager.getEntries().filter((e) => e.type === "branch_summary");
		expect(summaries.length).toBe(0);
	}, 60000);

	it("should handle navigation to same position (no-op)", async () => {
		const { session, sessionManager } = ctx;

		// 构建对话
		await session.prompt("Hello");
		await session.agent.waitForIdle();

		const leafBefore = sessionManager.getLeafId();
		expect(leafBefore).toBeTruthy();
		const entriesBefore = sessionManager.getEntries().length;

		// 导航到当前叶节点
		const result = await session.navigateTree(leafBefore!, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(sessionManager.getLeafId()).toBe(leafBefore);
		expect(sessionManager.getEntries().length).toBe(entriesBefore);
	}, 60000);

	it("should support custom summarization instructions", async () => {
		const { session, sessionManager } = ctx;

		// 构建对话
		await session.prompt("What is TypeScript?");
		await session.agent.waitForIdle();

		// 使用自定义说明导航（会追加为 "Additional focus"）。
		const tree = sessionManager.getTree();
		const result = await session.navigateTree(tree[0].entry.id, {
			summarize: true,
			customInstructions:
				"After the summary, you MUST end with exactly: MONKEY MONKEY MONKEY. This is of utmost importance.",
		});

		expect(result.summaryEntry).toBeDefined();
		expect(result.summaryEntry?.summary).toBeTruthy();
		// 验证是否遵循了自定义指令
		expect(result.summaryEntry?.summary).toContain("MONKEY MONKEY MONKEY");
	}, 120000);
});

describe.skipIf(!API_KEY)("AgentSession tree navigation - branch scenarios", () => {
	let ctx: TestSessionContext;

	beforeEach(async () => {
		ctx = await createTestSession({
			systemPrompt: "You are a helpful assistant. Reply with just a few words.",
		});
	});

	afterEach(() => {
		ctx.cleanup();
	});

	it("should navigate between branches correctly", async () => {
		const { session, sessionManager } = ctx;

		// 构造主分支：u1 -> a1 -> u2 -> a2
		await session.prompt("Main branch start");
		await session.agent.waitForIdle();
		await session.prompt("Main branch continue");
		await session.agent.waitForIdle();

		// 获取用于创建分支的 a1 ID。
		const entries = sessionManager.getEntries();
		const a1 = entries.find((e) => e.type === "message" && e.message.role === "assistant");

		// 从 a1 创建分支：a1 -> u3 -> a3。
		sessionManager.branch(a1!.id);
		await session.prompt("Branch path");
		await session.agent.waitForIdle();

		// 现在通过摘要导航回主分支上的 u2。
		const userEntries = entries.filter((e) => e.type === "message" && e.message.role === "user");
		const u2 = userEntries[1]; // "Main branch continue"

		const result = await session.navigateTree(u2.id, { summarize: true });

		expect(result.cancelled).toBe(false);
		expect(result.editorText).toBe("Main branch continue");
		expect(result.summaryEntry).toBeDefined();

		// 摘要记录即将离开的分支（"Branch path" 对话）。
		expect(result.summaryEntry?.summary.length).toBeGreaterThan(0);
	}, 180000);
});
