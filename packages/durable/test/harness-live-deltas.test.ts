import type { Op } from "@earendil-works/chord/delta";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type CommitPublication,
	defineTool,
	type Harness,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { context, documentChanges } from "./session-support.ts";

type Action = (api: ToolExecutionApi) => void | Promise<void>;

/**
 * 逐步驱动一次工具调用，并捕获每次 `pi.live` 提交产生的确切 Chord 操作。每次调用 `step()`
 * 都会在工具中执行一个操作，并返回该操作触发的提交内容。
 */
async function drive(outputLimits: ToolRegistration["outputLimits"] = {}) {
	const setup = chatSetup();
	const actions: ((api: ToolExecutionApi) => Promise<boolean>)[] = [];
	let wake: (() => void) | undefined;
	addTool(
		setup.registry,
		defineTool({
			name: "drive",
			description: "Driven by the test",
			parameters: Type.Object({}),
			outputLimits,
			execute: async (_args, api, callContext) => {
				for (;;) {
					while (actions.length === 0) {
						await new Promise<void>((resolve, reject) => {
							wake = resolve;
							const signal = callContext.abortSignal!;
							signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						});
					}
					if (!(await actions.shift()!(api))) return {};
				}
			},
		}),
	);
	setup.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("drive", {}, { id: "c1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	const commits: Op[][] = [];
	harness.subscribeCommits((publication) => {
		for (const change of documentChanges(publication)) {
			if (change.record.kind === "pi.live" && change.ops.length > 0) commits.push([...change.ops]);
		}
	});
	const submission = await root.submit({ type: "input", content: "go" }, context);
	await waitFor(async () => (await live(harness))?.tools?.[0]?.status === "running");
	const push = (action: (api: ToolExecutionApi) => Promise<boolean>): void => {
		actions.push(action);
		wake?.();
	};
	return {
		harness,
		commits,
		/** 目前每次 `pi.live` 提交产生的操作。 */
		async step(action: Action): Promise<readonly Op[]> {
			const before = commits.length;
			push(async (api) => {
				await action(api);
				return true;
			});
			await waitFor(() => commits.length > before);
			return commits.at(-1)!;
		},
		/** 等待工具返回且运行结束，并返回此期间产生的提交。 */
		async finish(): Promise<readonly Op[][]> {
			const before = commits.length;
			push(async () => false);
			await submission.wait(context);
			return commits.slice(before);
		},
	};
}

function live(harness: Harness): Promise<Readonly<LiveState> | undefined> {
	return harness.snapshot(LiveDoc, 1 as never, context);
}

const OUTPUT = ["tools", 0, "output"];

function isOutput(op: Op): boolean {
	return JSON.stringify(op[1]) === JSON.stringify(OUTPUT);
}

describe("pi.live deltas", () => {
	it("hands a generation over to its tool round and starts a tool with one field write each", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "noop",
				description: "noop",
				parameters: Type.Object({}),
				execute: async () => ({ output: [] }),
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const commits: Op[][] = [];
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				if (change.record.kind === "pi.live" && change.ops.length > 0) commits.push([...change.ops]);
			}
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const tasks = await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 20), context);
		const id = (kind: string) => tasks.items.filter((task) => task.kind === kind).map((task) => task.id);
		const [firstGeneration, secondGeneration] = id("pi.generation").sort((a, b) => a - b);
		const [tool] = id("pi.tool");
		const entries = await root.entries({}, 10, undefined, context);
		const result = entries.items.find((entry) => entry.kind === "pi.tool-result")!.id;
		expect(commits).toEqual([
			// 提交阶段。
			[["s", ["run"], { taskId: firstGeneration, inputs: [expect.any(Number)] }]],
			// 请求阶段。
			[["s", ["generation"], { attempt: 1 }]],
			// generation 开始工具轮次，并保持运行状态
			expect.arrayContaining([
				["d", ["generation"]],
				["s", ["tools"], [{ callId: "c1", name: "noop", taskId: tool, status: "pending" }]],
			]),
			// 意图阶段。
			[["s", ["tools", 0, "status"], "running"]],
			// 结果阶段。
			expect.arrayContaining([
				["s", ["tools", 0, "status"], "done"],
				["s", ["tools", 0, "entry"], result],
			]),
			// generation 的工具阶段将运行交给下一个 generation
			expect.arrayContaining([
				["d", ["tools"]],
				["s", ["run", "taskId"], secondGeneration],
			]),
			[["s", ["generation"], { attempt: 1 }]],
			// 答案使运行结束
			expect.arrayContaining([
				["d", ["run"]],
				["d", ["generation"]],
			]),
		]);
		expect(commits[2]).toHaveLength(2);
		expect(commits[4]).toHaveLength(2);
		expect(commits[5]).toHaveLength(2);
		await harness.close(context);
	});

	it("appends head output and then only updates the dropped counts once the window is full", async () => {
		const run = await drive({ maxLines: 2 });
		expect(await run.step((api) => api.output("one\n"))).toEqual([["s", OUTPUT, "one\n"]]);
		expect(await run.step((api) => api.output("two\n"))).toEqual([["a", OUTPUT, "two\n"]]);
		// 窗口已满：保留文本不变，只更新丢弃内容的计数。
		expect(await run.step((api) => api.output("three\n"))).toEqual([
			["s", ["tools", 0, "droppedBytes"], 6],
			["s", ["tools", 0, "droppedLines"], 1],
		]);
		expect(await run.step((api) => api.output("four\n"))).toEqual([
			["s", ["tools", 0, "droppedBytes"], 11],
			["s", ["tools", 0, "droppedLines"], 2],
		]);
		await run.finish();
		await run.harness.close(context);
	});

	it("slides a tail window as a front trim plus an append", async () => {
		const run = await drive({ maxLines: 3, retain: "tail" });
		expect(await run.step((api) => api.output("line 1\nline 2\nline 3\n"))).toEqual([
			["s", OUTPUT, "line 1\nline 2\nline 3\n"],
		]);
		expect(await run.step((api) => api.output("line 4\n"))).toEqual([
			["t", OUTPUT, 7],
			["a", OUTPUT, "line 4\n"],
			["s", ["tools", 0, "droppedBytes"], 7],
			["s", ["tools", 0, "droppedLines"], 1],
		]);
		// 缓冲区只保留窗口内的内容，后续滑动窗口时产生的操作仍精简且准确。
		expect(await run.step((api) => api.output("line 5\nline 6\n"))).toEqual([
			["t", OUTPUT, 14],
			["a", OUTPUT, "line 5\nline 6\n"],
			["s", ["tools", 0, "droppedBytes"], 21],
			["s", ["tools", 0, "droppedLines"], 3],
		]);
		expect((await live(run.harness))?.tools?.[0]?.output).toBe("line 4\nline 5\nline 6\n");
		await run.finish();
		await run.harness.close(context);
	});

	it("writes the whole window when Chord's overlap search cannot find the shared part", async () => {
		// 保留窗口超出 64 KiB 的重叠扫描范围。
		const wide = await drive({ maxBytes: 100 * 1024, maxLines: 1_000_000, retain: "tail" });
		const line = (index: number) => `${String(index).padStart(10, "0")} ${"x".repeat(989)}\n`;
		let text = "";
		for (let index = 0; index < 100; index++) text += line(index);
		await wide.step((api) => api.output(text));
		const slid = await wide.step((api) => api.output(line(100) + line(101) + line(102) + line(103)));
		expect(slid.filter(isOutput).map((op) => op[0])).toEqual(["s"]);
		await wide.finish();
		await wide.harness.close(context);

		// 此处的重复输出仍可找到重叠部分；对于其他输入，Chord 的候选搜索有界，可能放弃查找并改为写入整个窗口。
		const repetitive = await drive({ maxLines: 50, retain: "tail" });
		await repetitive.step((api) => api.output("y\n".repeat(50)));
		const repeated = await repetitive.step((api) => api.output("z\n"));
		expect(repeated.filter(isOutput)).toEqual([
			["t", OUTPUT, 2],
			["a", OUTPUT, "z\n"],
		]);
		await repetitive.finish();
		await repetitive.harness.close(context);
	});

	it("diffs details leaf by leaf and appends diagnostics", async () => {
		const run = await drive();
		const details = ["tools", 0, "details"];
		expect(await run.step((api) => api.details({ step: 1, log: "a" }, context))).toEqual([
			["s", details, { step: 1, log: "a" }],
		]);
		expect(await run.step((api) => api.details({ step: 2, log: "ab" }, context))).toEqual(
			expect.arrayContaining([
				["s", [...details, "step"], 2],
				["a", [...details, "log"], "b"],
			]),
		);
		expect(await run.step((api) => api.details({ step: 2 }, context))).toEqual([["d", [...details, "log"]]]);
		const diagnostics = ["tools", 0, "diagnostics"];
		const first = { severity: "info", message: "first" } as const;
		const second = { severity: "warn", message: "second" } as const;
		expect(await run.step((api) => api.diagnostic(first))).toEqual([["s", diagnostics, [first]]]);
		expect(await run.step((api) => api.diagnostic(second))).toEqual([["p", diagnostics, 1, 0, [second]]]);
		// 结算时会将所有内容移入结果条目，并保持槽位精简。
		const [settled] = await run.finish();
		expect(settled).toEqual(
			expect.arrayContaining([
				["s", ["tools", 0, "status"], "done"],
				["d", details],
				["d", diagnostics],
			]),
		);
		await run.harness.close(context);
	});

	it("streams partial text as appends", async () => {
		const setup = chatSetup({ tokensPerSecond: 400, tokenSize: { min: 4, max: 4 } });
		setup.faux.setResponses([fauxAssistantMessage([fauxText("word ".repeat(250))])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const commits: Op[][] = [];
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				if (change.record.kind === "pi.live" && change.ops.length > 0) commits.push([...change.ops]);
			}
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const partials = commits.slice(2, -1);
		expect(partials.length).toBeGreaterThan(2);
		expect(partials[0]).toEqual([["s", ["generation", "message"], expect.any(Object)]]);
		for (const ops of partials.slice(1)) {
			expect(ops).toEqual([["a", ["generation", "message", "content", 0, "text"], expect.any(String)]]);
		}
		await harness.close(context);
	});

	it("stores a complete base exactly in the commits where nothing runs", async () => {
		// 记录每次提交将 pi.live 写为完整基线还是增量的存储。
		const written = new Map<number, "base" | "delta">();
		let liveId: number | undefined;
		class RecordingStorage extends MemoryStorage {
			override async commit(
				writes: Parameters<MemoryStorage["commit"]>[0],
				context: Parameters<MemoryStorage["commit"]>[1],
			) {
				let kind: "base" | "delta" | undefined;
				for (const write of writes) {
					if (write.type === "document.change" && write.id === liveId) kind = write.content.kind;
				}
				const seq = await super.commit(writes, context);
				if (kind !== undefined) written.set(seq, kind);
				return seq;
			}
		}
		const setup = chatSetup();
		for (const name of ["first", "second"]) {
			addTool(
				setup.registry,
				defineTool({
					name,
					description: name,
					parameters: Type.Object({}),
					execute: async (_args, api) => {
						api.output(`${name} output\n`);
						await new Promise((resolve) => setTimeout(resolve, 150));
						api.output(`${name} more\n`);
						return {};
					},
				}),
			);
		}
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("first", {}, { id: "a" }), fauxToolCall("second", {}, { id: "b" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		setup.settings.toolExecution = "sequential";
		const { harness, root } = await openChat(new RecordingStorage(), setup);
		const values = new Map<number, LiveState>();
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				if (change.record.kind !== "pi.live") continue;
				liveId = change.record.id;
				if (change.value !== null) values.set(publication.seq, change.value as LiveState);
			}
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const nothingRuns = (value: LiveState) =>
			value.generation === undefined && !(value.tools ?? []).some((slot) => slot.status === "running");
		const kinds = [...written].map(([seq, kind]) => {
			expect(kind === "base").toBe(nothingRuns(values.get(seq)!));
			return kind;
		});
		// 完整基线分别写于交接时、每个顺序执行的工具结束后、本轮结束后以及运行结束时。
		expect(kinds.filter((kind) => kind === "base").length).toBeGreaterThanOrEqual(5);
		expect(kinds).toContain("delta");
		await harness.close(context);
	});

	it("starts calls the request did not offer as done and marks a faulted tool's slot done without an entry", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "bad",
				description: "bad",
				parameters: Type.Object({}),
				// 不是严格 JSON：结果提交会抛出异常，调度器会将任务标记为故障。
				execute: async () => ({ output: [], details: { fn: (() => 1) as never } }),
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ghost", {}, { id: "g" }), fauxToolCall("bad", {}, { id: "b" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const commits: Op[][] = [];
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				if (change.record.kind === "pi.live" && change.ops.length > 0) commits.push([...change.ops]);
			}
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const entries = await root.entries({}, 10, undefined, context);
		const ghostResult = entries.items.find((entry) => entry.kind === "pi.tool-result")!.id;
		const handover = commits.find((ops) => ops.some((op) => op[0] === "s" && op[1][0] === "tools"))!;
		expect(handover).toContainEqual([
			"s",
			["tools"],
			[
				{ callId: "g", name: "ghost", status: "done", entry: ghostResult },
				{ callId: "b", name: "bad", taskId: expect.any(Number), status: "pending" },
			],
		]);
		// 故障清理只写入状态。
		expect(commits).toContainEqual([["s", ["tools", 1, "status"], "done"]]);
		await harness.close(context);
	});

	it("commits the tool-calling answer, its tool tasks, the generation's wait, and the tool round in one commit", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "noop",
				description: "noop",
				parameters: Type.Object({}),
				execute: async () => ({ output: [] }),
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("noop", {}, { id: "a" }), fauxToolCall("noop", {}, { id: "b" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		let handover: CommitPublication | undefined;
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				if (change.record.kind === "pi.live" && (change.value as LiveState | null)?.tools?.length === 2) {
					handover ??= publication;
				}
			}
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const changes = handover!.changes;
		const kinds = changes.flatMap((change) =>
			change.type === "entry" ? [change.value.kind] : change.type === "task" ? [change.value.kind] : [],
		);
		expect(kinds.sort()).toEqual(["pi.assistant", "pi.generation", "pi.tool", "pi.tool"]);
		await harness.close(context);
	});

	it("writes an aborted tool's slot with field-level ops", async () => {
		const run = await drive();
		await run.step((api) => api.output("partial\n"));
		await run.step((api) => api.details({ n: 1 }, context));
		const taskId = (await live(run.harness))!.tools![0]!.taskId!;
		const before = run.commits.length;
		await run.harness.abortTask(taskId, context);
		const isAbortCommit = (ops: readonly Op[]) =>
			ops.some((op) => op[0] === "s" && JSON.stringify(op[1]) === JSON.stringify(["tools", 0, "status"]));
		await waitFor(() => run.commits.slice(before).some(isAbortCommit));
		const abortCommit = run.commits.slice(before).find(isAbortCommit)!;
		expect(abortCommit).toEqual(
			expect.arrayContaining([
				["s", ["tools", 0, "status"], "done"],
				["s", ["tools", 0, "entry"], expect.any(Number)],
				["d", OUTPUT],
				["d", ["tools", 0, "details"]],
			]),
		);
		expect(abortCommit).toHaveLength(4);
		await run.harness.close(context);
	});

	it("keeps a complete base exactly while nothing runs", () => {
		const base = (value: LiveState) =>
			LiveDoc.definition.checkpointWhen!(value, [], { deltasSinceBase: 1000 } as never);
		const slot = (status: "pending" | "running" | "done") => ({ callId: "c", name: "n", status });
		const run = { taskId: 1 as never, inputs: [] };
		expect(base({})).toBe(true);
		expect(base({ run, generation: { attempt: 1 } })).toBe(false);
		expect(base({ run, tools: [slot("pending"), slot("done")] })).toBe(true);
		expect(base({ run, tools: [slot("done"), slot("running")] })).toBe(false);
		expect(base({ run })).toBe(true);
	});
});
