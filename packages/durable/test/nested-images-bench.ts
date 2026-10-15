/**
 * 嵌套图像存储基准测试。模型发起一次 `script` 调用（类似代码模式调用），循环 `count` 次：每次先通过嵌套的
 * `read_image` 调用返回一张由 `bytes` 个字符组成的唯一 Base64 图像，再通过嵌套的 `classify` 调用读取它。
 * `inline` 变体将图像数据放入 `classify` 参数；`reference` 变体传入 `read_image` 结果的 `taskId`，由 `classify`
 * 从调用方的 `NestedResultDoc` 中读取图像。统计提交次数、耗时、按写入类型划分的逻辑写入字节数（存储写入的 JSON 大小）、
 * `script` 返回前/运行结算后/关闭后/重新打开后的存储大小，以及堆内存：运行期间每 5 毫秒和每次提交时采样峰值，
 * 运行结算后执行 GC、`waitForIdle()` 后和重新打开后的堆大小（均以打开前 GC 后的堆大小为基准），并统计嵌套任务记录数和最大记录大小。
 *
 *   node --conditions=source --experimental-strip-types --expose-gc test/nested-images-bench.ts [count]
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type JsonObject,
	NestedResultDoc,
	type Storage,
	type StorageWrite,
	ToolResultEntry,
	type ToolTaskInput,
} from "../src/index.ts";
import { openNodeJsonlStorage } from "../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";

type Backend = "sqlite" | "jsonl";
type Variant = "inline" | "reference";
type Scenario = { backend: Backend; variant: Variant; count: number; bytes: number };
/** 在工具调用中执行的探针：采样堆内存，并在 `script` 返回前测量存储大小。 */
type Probe = { sample: () => void; beforeReturn: () => Promise<void> };
type Written = Record<StorageWrite["type"], number>;
type Result = {
	commits: number;
	ms: number;
	written: Written;
	/** `script` 返回前测得的大小，此时嵌套结果仍然有效。 */
	storedLive: number;
	storedRun: number;
	storedClosed: number;
	storedReopened: number;
	/** 相对于打开存储前 GC 后的堆大小。 */
	peakHeap: number;
	settledHeap: number;
	idleHeap: number;
	reopenedHeap: number;
	nestedTasks: number;
	largestTask: number;
};

const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("Run with --expose-gc");

function heapAfterGc(): number {
	gc!();
	return process.memoryUsage().heapUsed;
}

async function directorySize(path: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const full = join(path, entry.name);
		total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size;
	}
	return total;
}

async function open(backend: Backend, directory: string): Promise<Storage> {
	return backend === "sqlite"
		? openNodeSqliteStorage(join(directory, "session.sqlite"))
		: openNodeJsonlStorage(directory, context);
}

function noWrites(): Written {
	return {
		conversation: 0,
		entry: 0,
		task: 0,
		submission: 0,
		"document.create": 0,
		"document.copy": 0,
		"document.change": 0,
		"document.retire": 0,
	};
}

const ImageArgument = Type.Object({
	type: Type.Literal("image"),
	mimeType: Type.String(),
	data: Type.Optional(Type.String()),
	source: Type.Optional(Type.Object({ taskId: Type.Number() })),
});

function registryFor(scenario: Scenario, probe: Probe) {
	const registry = createRegistry();
	const readImage = defineTool({
		name: "read_image",
		description: "Read an image",
		parameters: Type.Object({ n: Type.Number() }),
		// 只返回一张图像，因此程序会将其作为 `ImageContent` 获取。每次调用都不同：内容由随机字节编码为 Base64。
		execute: async () => ({
			output: [
				{ type: "image", data: randomBytes((scenario.bytes / 4) * 3).toString("base64"), mimeType: "image/png" },
			],
		}),
	});
	const classify = defineTool({
		name: "classify",
		description: "Classify images",
		parameters: Type.Object({ images: Type.Array(ImageArgument) }),
		execute: async (args, api, callContext) => {
			for (const image of args.images) {
				let data = image.data;
				if (image.source !== undefined) {
					// 调用方是嵌套调用的 `parent`；其 `NestedResultDoc` 保存了被引用的结果。
					const input = (await api.getTask(api.taskId, callContext))?.input as ToolTaskInput | undefined;
					if (input?.kind !== "nested") throw new Error("classify resolves references only as a nested call");
					const stored = await api.snapshot(
						NestedResultDoc,
						input.parent,
						String(image.source.taskId),
						callContext,
					);
					const block = stored?.result.structuredOutput as ImageContent | undefined;
					data = block?.type === "image" ? block.data : undefined;
				}
				if (data?.length !== scenario.bytes) throw new Error(`Image has ${data?.length} characters`);
			}
			return { output: [{ type: "text", text: "ok" }] };
		},
	});
	const script = defineTool({
		name: "script",
		description: "Read and classify images",
		parameters: Type.Object({ count: Type.Number() }),
		callers: ["model"],
		execute: async (args, api, callContext) => {
			for (let n = 0; n < args.count; n++) {
				const key = `read${n}`;
				const read = await api.executeTool("read_image", { n }, callContext, { key });
				const image = read.structuredOutput as unknown as ImageContent;
				const argument: JsonObject =
					scenario.variant === "inline"
						? { type: "image", data: image.data, mimeType: image.mimeType }
						: { type: "image", source: { taskId: read.taskId }, mimeType: image.mimeType };
				const classified = await api.executeTool("classify", { images: [argument] }, callContext, {
					key: `classify${n}`,
				});
				if (classified.isError) throw new Error(`classify ${n} failed: ${JSON.stringify(classified.diagnostics)}`);
				probe.sample();
			}
			await probe.beforeReturn();
			return { output: [{ type: "text", text: `classified ${args.count}` }] };
		},
	});
	registry.install(defineExtension({ name: "bench", tools: [readImage, classify, script] }));
	return registry;
}

async function runScenario(scenario: Scenario): Promise<Result> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-images-bench-"));
	try {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		let peakHeap = 0;
		let storedLive = 0;
		const sample = () => {
			peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
		};
		const registry = registryFor(scenario, {
			sample,
			beforeReturn: async () => {
				storedLive = await directorySize(directory);
			},
		});
		const baseHeap = heapAfterGc();

		const storage = await open(scenario.backend, directory);
		let commits = 0;
		const written = noWrites();
		const commit = storage.commit.bind(storage);
		storage.commit = (writes, commitContext) => {
			commits++;
			// SQLite 会同步提交，可能导致计时器得不到运行机会，因此也在此处采样。
			sample();
			for (const write of writes) written[write.type] += JSON.stringify(write).length;
			return commit(writes, commitContext);
		};
		const harness = await Harness.open(storage, { models, registry }, context);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("script", { count: scenario.count }, { id: "s" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const before = { commits, written: { ...written } };
		peakHeap = 0;
		const sampler = setInterval(sample, 5);
		const started = performance.now();
		const settled = await (await root.submit({ type: "input", content: "run" }, context)).wait(context);
		if (settled.status !== "done") throw new Error(`run: ${settled.status}`);
		// `done` 只表示模型已回答；脚本的结果才说明执行是否完整结束。
		const latest = (await root.entries({}, 10, undefined, context)).items;
		const result = latest.find((entry) => ToolResultEntry.is(entry))?.model?.[0];
		if (result?.role !== "toolResult" || result.isError) throw new Error("run: the script failed");
		const ms = Math.round(performance.now() - started);
		clearInterval(sampler);
		const settledHeap = heapAfterGc() - baseHeap;
		await harness.waitForIdle(context);
		const idleHeap = heapAfterGc() - baseHeap;
		const delta = noWrites();
		for (const type of Object.keys(delta) as StorageWrite["type"][]) {
			delta[type] = written[type] - before.written[type];
		}
		const storedRun = await directorySize(directory);
		await harness.close(context);
		const storedClosed = await directorySize(directory);

		const reopenedStorage = await open(scenario.backend, directory);
		const reopened = await Harness.open(reopenedStorage, { models, registry }, context);
		const reopenedHeap = heapAfterGc() - baseHeap;
		const storedReopened = await directorySize(directory);
		let nestedTasks = 0;
		let largestTask = 0;
		let cursor: Parameters<Storage["scanTasks"]>[2];
		do {
			const page = await reopenedStorage.scanTasks({ kind: "pi.tool" }, 50, cursor, context);
			for (const record of page.items) {
				if ((record.input as ToolTaskInput).kind === "nested") nestedTasks++;
				largestTask = Math.max(largestTask, JSON.stringify(record).length);
			}
			cursor = page.next;
		} while (cursor !== undefined);
		await reopened.close(context);
		return {
			commits: commits - before.commits,
			ms,
			written: delta,
			storedLive,
			storedRun,
			storedClosed,
			storedReopened,
			peakHeap: peakHeap - baseHeap,
			settledHeap,
			idleHeap,
			reopenedHeap,
			nestedTasks,
			largestTask,
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function mib(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function kib(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function main(): Promise<void> {
	const counts = process.argv[2] === undefined ? [50, 200] : [Number(process.argv[2])];
	const bytes = 1024 * 1024;
	console.log(`Images: ${bytes / 1024} KiB base64 each, read then classified sequentially in one script call`);
	console.log(
		"backend | variant   | count | commits, ms | written: all (task / doc create / doc change / entry) | stored: live / run / closed / reopened | heap: peak; settled / idle / reopened | nested tasks, largest task",
	);
	for (const count of counts) {
		for (const backend of ["sqlite", "jsonl"] as const) {
			for (const variant of ["inline", "reference"] as const) {
				const result = await runScenario({ backend, variant, count, bytes });
				const all = Object.values(result.written).reduce((sum, value) => sum + value, 0);
				const written = result.written;
				console.log(
					[
						backend.padEnd(7),
						variant.padEnd(9),
						String(count).padEnd(5),
						`${result.commits}, ${result.ms} ms`,
						`${mib(all)} (${mib(written.task)} / ${mib(written["document.create"])} / ${mib(written["document.change"])} / ${mib(written.entry)})`,
						`${mib(result.storedLive)} / ${mib(result.storedRun)} / ${mib(result.storedClosed)} / ${mib(result.storedReopened)}`,
						`${mib(result.peakHeap)}; ${mib(result.settledHeap)} / ${mib(result.idleHeap)} / ${mib(result.reopenedHeap)}`,
						`${result.nestedTasks}, ${kib(result.largestTask)}`,
					].join(" | "),
				);
			}
		}
	}
}

await main();
