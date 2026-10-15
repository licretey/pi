/**
 * 工具输出基准测试：运行实际工具任务、自适应进度节流和 `pi.live` 提交流程。
 *
 *   node --conditions=source --experimental-strip-types --expose-gc test/tool-output-bench.ts
 *
 * 每个场景都在独立子进程中运行，以单独测量其 RSS 峰值。速率场景会在固定时间内写入输出，
 * 然后在一轮中途关闭 Harness（持久化后端），测量重新打开时重放该轮增量链的耗时；
 * 最后完成运行，以测量该轮基准提交和回收后的存储大小。吞吐量场景会写入 1 GiB 数据。
 */
import { execFile } from "node:child_process";
import { mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createRegistry, defineTool, Harness, LiveDoc, MemoryStorage, type Storage } from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { createBashTool } from "../src/tools/index.ts";
import { addTool } from "./harness-support.ts";

type Backend = "memory" | "sqlite" | "jsonl";
type Rate = "low" | "normal" | "high";
type Scenario =
	| { kind: "rate"; backend: Backend; rate: Rate; retain: "head" | "tail"; tools: number; seconds?: number }
	| { kind: "firehose"; backend: Backend; retain: "head" | "tail"; repetitive?: boolean }
	| { kind: "cat"; backend: Backend };

const RATE_SECONDS = 3;
const GIB = 1 << 30;
const LINE = "The quick brown fox jumps over the lazy dog. Unique identifier";
const BIG_FILE = join(tmpdir(), "pi-durable-bench-1gib.txt");

/** 工具每个时钟周期写入的输出，以及周期之间的暂停时间。 */
const RATES: Record<Rate, { readonly lines: number; readonly pauseMs: number }> = {
	// 每 200 毫秒输出一行，模拟缓慢的构建步骤。
	low: { lines: 1, pauseMs: 200 },
	// 每 50 毫秒突发输出 25 行（约 40 KB/s），模拟编译器或测试运行。
	normal: { lines: 25, pauseMs: 50 },
	// 连续输出 64 KiB 数据块，并在块之间让出事件循环。
	high: { lines: 800, pauseMs: 0 },
};

async function main(): Promise<void> {
	const [, , encoded] = process.argv;
	if (encoded !== undefined) {
		const result = await runScenario(JSON.parse(encoded) as Scenario);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	const scenarios: Scenario[] = [];
	for (const backend of ["memory", "sqlite", "jsonl"] as const) {
		for (const rate of ["low", "normal", "high"] as const) {
			for (const retain of ["head", "tail"] as const) {
				for (const tools of [1, 4]) scenarios.push({ kind: "rate", backend, rate, retain, tools });
			}
		}
		for (const retain of ["head", "tail"] as const) scenarios.push({ kind: "firehose", backend, retain });
		// 相同行：统计 Chord 的有界重叠搜索回退为写入整个尾部窗口的频率。
		scenarios.push({ kind: "firehose", backend, retain: "tail", repetitive: true });
		// 单个长轮次：持续输出的尾部工具在该轮基准提交前构建的增量链。
		if (backend !== "memory")
			scenarios.push({ kind: "rate", backend, rate: "high", retain: "tail", tools: 1, seconds: 30 });
		scenarios.push({ kind: "cat", backend });
	}
	await ensureBigFile();
	const rows: Record<string, unknown>[] = [];
	for (const scenario of scenarios) {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[...process.execArgv, fileURLToPath(import.meta.url), JSON.stringify(scenario)],
			{ maxBuffer: 1 << 20 },
		);
		rows.push({ ...label(scenario), ...JSON.parse(stdout.trim().split("\n").at(-1)!) });
	}
	console.table(rows);
}

function label(scenario: Scenario): Record<string, unknown> {
	if (scenario.kind === "rate") {
		const { backend, rate, retain, tools, seconds } = scenario;
		return { scenario: `${rate} ${retain} x${tools}${seconds === undefined ? "" : ` ${seconds}s`}`, backend };
	}
	if (scenario.kind === "cat") return { scenario: "bash cat 1 GiB", backend: scenario.backend };
	const repetitive = scenario.repetitive === true ? " repetitive" : "";
	return { scenario: `api.output 1 GiB ${scenario.retain}${repetitive}`, backend: scenario.backend };
}

async function ensureBigFile(): Promise<void> {
	if ((await stat(BIG_FILE).catch(() => undefined))?.size === GIB) return;
	// 不重复的行，每次写入 64 MiB，恰好在 1 GiB 处截断。
	const file = await open(BIG_FILE, "w");
	try {
		let index = 0;
		for (let written = 0; written < GIB; ) {
			let block = "";
			while (block.length < 64 << 20) block += `Line ${index++}: ${LINE}: ${(index * 7919).toString(16)}\n`;
			const bytes = Buffer.from(block).subarray(0, GIB - written);
			await file.write(bytes);
			written += bytes.length;
		}
	} finally {
		await file.close();
	}
}

type Metrics = {
	ms: number;
	liveCommits: number;
	liveOpKiB: number;
	/** 将输出写入记录为完整字符串集合，包含每个槽位的首次写入；其余操作均为追加或截断。 */
	outputSets: number;
	commitP50Ms: number;
	commitP99Ms: number;
	midRoundKiB?: number;
	replayMs?: number;
	finalKiB?: number;
	peakRssMiB: number;
	heapAfterGcMiB?: number;
};

async function runScenario(scenario: Scenario): Promise<Metrics> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-tool-bench-"));
	try {
		const path = join(directory, scenario.backend === "sqlite" ? "session.sqlite" : "session");
		const latencies: number[] = [];
		const openTimed = async (): Promise<Storage> => timed(await openStorage(scenario.backend, path), latencies);
		let stop = false;
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const toolCount = scenario.kind === "rate" ? scenario.tools : 1;
		if (scenario.kind === "cat") {
			addTool(registry, createBashTool());
		} else {
			const rate = scenario.kind === "rate" ? RATES[scenario.rate] : RATES.high;
			addTool(
				registry,
				defineTool({
					name: "emit",
					description: "",
					parameters: Type.Object({}),
					outputLimits: { retain: scenario.retain },
					execute: async (_args, api, callContext) => {
						let counter = 0;
						let written = 0;
						// 高速连续输出场景复用预先构建的数据块，以测量 Harness 性能，而非字符串构建速度。
						const prebuilt = scenario.kind === "firehose" ? lines(api.callId, 0, rate.lines) : undefined;
						// 重复输出：每个数据块包含相同的行和一行编号，因此尾部窗口会持续滑动。
						const repeated = "y\n".repeat(32 * 1024 - 8);
						while (!stop && (scenario.kind === "rate" || written < GIB)) {
							const chunk =
								scenario.kind === "firehose" && scenario.repetitive === true
									? `${repeated}#${counter}\n`
									: (prebuilt ?? lines(api.callId, counter, rate.lines));
							counter += rate.lines;
							api.output(chunk);
							written += chunk.length;
							await new Promise((resolve) =>
								rate.pauseMs === 0 ? setImmediate(resolve) : setTimeout(resolve, rate.pauseMs),
							);
						}
						// 持久化速率场景会一直运行到关闭，因此重新打开时会重放该轮。
						if (scenario.kind === "rate" && scenario.backend !== "memory") {
							await new Promise((_, reject) =>
								callContext.abortSignal!.addEventListener("abort", () =>
									reject(callContext.abortSignal!.reason),
								),
							);
						}
						return {};
					},
				}),
			);
		}
		const call =
			scenario.kind === "cat"
				? [fauxToolCall("bash", { command: `cat ${BIG_FILE}` }, { id: "c0" })]
				: Array.from({ length: toolCount }, (_, index) => fauxToolCall("emit", {}, { id: `c${index}` }));
		faux.setResponses([
			fauxAssistantMessage(call, { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const nodeEnv = new NodeExecutionEnv({ cwd: directory });
		const env = () => nodeEnv;
		let harness = await Harness.open(await openTimed(), { models, registry, env }, context);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		let liveCommits = 0;
		let liveOpBytes = 0;
		let outputSets = 0;
		const observe = (target: Harness): void => {
			target.subscribeCommits((publication) => {
				for (const change of publication.changes) {
					if (change.type !== "document" || change.record.kind !== "pi.live") continue;
					liveCommits++;
					liveOpBytes += JSON.stringify(change.ops).length;
					for (const op of change.ops) if (op[0] === "s" && op[1].at(-1) === "output") outputSets++;
				}
			});
		};
		observe(harness);
		const started = performance.now();
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const metrics: Partial<Metrics> = {};
		if (scenario.kind === "rate") {
			await new Promise((resolve) => setTimeout(resolve, (scenario.seconds ?? RATE_SECONDS) * 1000));
			stop = true;
			if (scenario.backend !== "memory") {
				// 等待最后一次进度提交完成，然后在一轮中途关闭，并测量重新打开时的重放耗时。
				await new Promise((resolve) => setTimeout(resolve, 600));
				metrics.midRoundKiB = await footprint(scenario.backend, path);
				await harness.close(context);
				const reopened = performance.now();
				harness = await Harness.open(await openTimed(), { models, registry, env }, context);
				await harness.snapshot(LiveDoc, root.id, context);
				observe(harness);
				metrics.replayMs = Math.round(performance.now() - reopened);
				harness.resume();
				await (await harness.submission(submission.id, context))!.wait(context);
			} else {
				await submission.wait(context);
			}
		} else {
			await submission.wait(context);
		}
		const ms = Math.round(performance.now() - started);
		if (scenario.backend !== "memory") metrics.finalKiB = await footprint(scenario.backend, path);
		await harness.close(context);
		latencies.sort((a, b) => a - b);
		const gc = (globalThis as { gc?: () => void }).gc;
		gc?.();
		return {
			ms,
			liveCommits,
			liveOpKiB: Math.round(liveOpBytes / 1024),
			outputSets,
			commitP50Ms: round(latencies[Math.floor(latencies.length * 0.5)] ?? 0),
			commitP99Ms: round(latencies[Math.floor(latencies.length * 0.99)] ?? 0),
			...metrics,
			peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
			heapAfterGcMiB: gc === undefined ? undefined : Math.round(process.memoryUsage().heapUsed / 2 ** 20),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function openStorage(backend: Backend, path: string): Promise<Storage> {
	if (backend === "memory") return new MemoryStorage();
	if (backend === "sqlite") return openNodeSqliteStorage(path);
	return openNodeJsonlStorage(path, context);
}

/** 测量每次 Storage 提交。 */
function timed(storage: Storage, latencies: number[]): Storage {
	return new Proxy(storage, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (property !== "commit" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (...args: unknown[]) => {
				const start = performance.now();
				try {
					return await value.apply(target, args);
				} finally {
					latencies.push(performance.now() - start);
				}
			};
		},
	});
}

async function footprint(backend: Backend, path: string): Promise<number> {
	if (backend === "sqlite") {
		let bytes = 0;
		for (const suffix of ["", "-wal", "-shm"]) bytes += (await stat(path + suffix).catch(() => undefined))?.size ?? 0;
		return Math.round(bytes / 1024);
	}
	let bytes = 0;
	for (const file of await readdir(path)) bytes += (await stat(join(path, file))).size;
	return Math.round(bytes / 1024);
}

function lines(prefix: string, first: number, count: number): string {
	let text = "";
	for (let index = first; index < first + count; index++) text += `${prefix} ${index}: ${LINE}\n`;
	return text;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

await main();
