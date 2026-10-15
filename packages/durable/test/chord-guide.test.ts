/**
 * 将 docs/pico-v5-chord-usage.md 中的代码通过真实 Harness 编译并运行。请保持两处同步：指南中的代码块
 * 会原样复制到此处，仅调整格式，并将输出目标改为记录而非打印。
 */
import {
	type Context,
	createFacetHost,
	createRemoteServiceBinding,
	defineFacet,
	defineService,
	type Facet,
	type FacetHost,
	type RemoteServiceTransport,
	type ReplicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import {
	type ConversationId,
	type DocumentObserver,
	defineDoc,
	defineDocFamily,
	defineTask,
	type Harness,
	MemoryStorage,
	type Session,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context } from "./session-support.ts";
import { completed, deferred, eventually, openTasks } from "./task-support.ts";

const logged: unknown[][] = [];
const console = { log: (...values: unknown[]) => void logged.push(values) };

// ─── 1. Session 级画布 ──────────────────────────────────────────────────────

type Stroke = { color: string; points: { x: number; y: number }[] };
type CanvasState = { strokes: Stroke[] };

const CanvasDoc = defineDoc<CanvasState>({
	kind: "app.canvas",
	version: 1,
	scope: "session",
	initial: () => ({ strokes: [] }),
	// 重放的增量最多达到 99 个后，保存一份完整基线。
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 99,
});

interface CanvasService {
	readonly state: ReplicatedState<CanvasState | null>;
	addStroke(stroke: Stroke, context: Context): Promise<void>;
}
const Canvas = defineService<CanvasService>("app.canvas");

async function createCanvasFacet(session: Session, context: Context): Promise<Facet> {
	// 创建操作必须显式执行；观察过程不会写入数据。
	await session.commit(async (tx) => {
		await tx.doc(CanvasDoc);
	}, context);
	const state = await session.documentState(CanvasDoc, context);
	if (state === undefined) throw new Error("canvas was retired during setup");
	return defineFacet({
		id: "app.canvas/session",
		setup(env) {
			env.own(() => state.dispose());
			env.provide(Canvas, {
				state,
				async addStroke(stroke, context) {
					await session.commit(async (tx) => {
						const draft = await tx.doc(CanvasDoc);
						draft.strokes.push(stroke); // Chord 会按值复制已赋值的按键序列。
					}, context);
				},
			});
		},
	});
}

const CanvasConsumer = defineFacet({
	id: "app.canvas/consumer",
	setup(env) {
		const canvas = env.use(Canvas); // 先声明，只在激活后访问。
		env.onActivate(() => {
			env.own(
				canvas.state.subscribe((value, _context, delivery) => {
					console.log(delivery.kind, delivery.sequence, value?.strokes.length ?? "retired");
				}),
			); // subscribe 会先传递当前已载入的值，再传递后续更新。
		});
	},
});

async function runCanvasExample(session: Session): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const provider = await createCanvasFacet(session, context);
	const host = await createFacetHost({ facets: [provider, CanvasConsumer] });
	try {
		await host.services.use(Canvas).addStroke(
			{
				color: "black",
				points: [
					{ x: 10, y: 20 },
					{ x: 30, y: 40 },
				],
			},
			context,
		);
	} finally {
		await host.dispose(); // 取消订阅，但不会删除画布或关闭 Session。
	}
}

async function connectCanvas(transport: RemoteServiceTransport, context: Context) {
	const services = createRemoteServiceBinding({ services: [Canvas], transport });
	const canvas = services.use(Canvas);
	const stop = canvas.state.subscribe((value, _context, delivery) => {
		console.log(delivery.kind, delivery.sequence, value?.strokes ?? "retired");
	});
	try {
		await services.ready(context); // 已安装初始快照；后续更新仍会继续到达。
	} catch (error) {
		stop();
		await services.dispose(BACKGROUND_CONTEXT);
		throw error;
	}
	return async () => {
		stop();
		await services.dispose(BACKGROUND_CONTEXT);
	};
}

async function shutdown(host: FacetHost, detachClients: () => Promise<void>, harness: Harness, context: Context) {
	await detachClients();
	await host.dispose();
	await harness.close(context);
}

// ─── 2. Conversation 级差异审查 ─────────────────────────────────────────────

type ReviewInput = { path: string; patch: string };
type ReviewComment = { id: string; line: number; text: string };
type ReviewState = ReviewInput & { comments: ReviewComment[] };
const ReviewDoc = defineDocFamily<ReviewState, ReviewInput>({
	kind: "app.diff-review",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: (seed) => ({ path: seed.path, patch: seed.patch, comments: [] }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 49,
});
interface DiffReviewService {
	readonly state: ReplicatedState<ReviewState | null>;
	identity(context: Context): Promise<{ conversationId: ConversationId; key: string }>;
	addComment(comment: ReviewComment, context: Context): Promise<void>;
}
const DiffReviews = defineService<DiffReviewService>("app.diff-reviews");

function reviewFacet(
	session: Session,
	conversationId: ConversationId,
	reviews: readonly { key: string; seed: ReviewInput }[],
	context: Context,
): Facet {
	return defineFacet({
		id: "app.diff-reviews/session",
		setup(env) {
			const instances = env.provideMany(DiffReviews);
			env.onActivate(async () => {
				for (const review of reviews) {
					await session.commit(async (tx) => {
						await tx.doc(ReviewDoc, conversationId, review.key, review.seed);
					}, context);
					const state = await session.documentState(ReviewDoc, conversationId, review.key, context);
					if (state === undefined) throw new Error("review was retired during setup");
					env.own(() => state.dispose());
					// Chord 实例键用于路由服务，并非文档实例的数字 ID。
					instances.spawn(JSON.stringify([conversationId, review.key]), {
						state,
						async identity() {
							return { conversationId, key: review.key };
						},
						async addComment(comment, context) {
							await session.commit(async (tx) => {
								const draft = await tx.doc(ReviewDoc, conversationId, review.key, review.seed);
								draft.comments.push(comment); // Chord 会按值复制所赋的评论对象。
							}, context);
						},
					}); // facet 会自动管理生成的服务实例的生命周期。
				}
			});
		},
	});
}

// ─── 3. Task 级输出及工具/任务观察器 ─────────────────────────────────────────

const sent: unknown[] = [];
const rendered: string[] = [];
async function sendCommittedFrame(value: JobOutput | null, ops: readonly Op[]): Promise<void> {
	sent.push({ value, ops });
}
async function render(text: string): Promise<void> {
	rendered.push(text);
}

type JobInput = { command: string };
type JobOutput = { stdout: string; chunks: number };
const JobOutputDoc = defineDoc<JobOutput>({
	kind: "app.job-output",
	version: 1,
	scope: "task",
	initial: () => ({ stdout: "", chunks: 0 }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 99,
});
async function appendJobOutput(
	runtime: TaskRuntime<JobInput, { phase: "running" }, null, object>,
	chunk: string,
	context: Context,
): Promise<void> {
	// 在此回调之外读取进程输出。运行时会控制活动任务的执行。
	await runtime.commit(async (tx) => {
		const draft = await tx.doc(JobOutputDoc, runtime.taskId);
		draft.stdout = (draft.stdout + chunk).slice(-50_000);
		draft.chunks += 1;
	}, context);
}
async function observeJob(
	api: DocumentObserver,
	producerTaskId: TaskId,
	finished: Promise<void>,
	context: Context,
): Promise<void> {
	const watch = await api.watchDoc(JobOutputDoc, producerTaskId, context);
	if (watch === undefined) return;
	console.log(watch.value === null ? "retired" : watch.value.stdout);
	try {
		watch.start(async (value, ops, _context) => {
			await sendCommittedFrame(value, ops);
			await render(value === null ? "retired" : value.stdout);
		}); // 回调会串行执行，不会彼此重叠。
		await finished; // 观察持续时间由调用方提供，且不在任何 commit 中执行。
	} finally {
		await watch.stop(); // 可重复调用；调用后不会再启动新的回调。
	}
}

// ─── 运行示例 ────────────────────────────────────────────────────────────────

/** 连接到宿主服务提供方的进程内传输；实际客户端会在两者之间使用套接字。 */
function inProcess(host: FacetHost): RemoteServiceTransport {
	return {
		invoke: (call, callContext) => host.services.invoke(call, callContext),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = host.services.subscribe(serviceId, mode, listener);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}

describe("Chord usage guide", () => {
	it("runs the canvas: facet host, a remote client, withdrawal and detach before Harness close", async () => {
		logged.length = 0;
		const { harness } = await openTasks(new MemoryStorage(), []);
		await runCanvasExample(harness);
		expect(logged).toEqual([
			["hydrate", 0, 0],
			["update", 1, 1],
		]);
		expect((await harness.snapshot(CanvasDoc, context))?.strokes).toHaveLength(1);

		// 工作进程再次安装画布 facet；之后连接的远程客户端会先载入笔画，再接收后续更新。
		logged.length = 0;
		const host = await createFacetHost({ facets: [await createCanvasFacet(harness, context)] });
		const detach = await connectCanvas(inProcess(host), context);
		await host.services.use(Canvas).addStroke({ color: "red", points: [] }, context);
		await eventually(() => logged.length === 2);
		expect(logged.map(([kind, , strokes]) => [kind, (strokes as Stroke[]).length])).toEqual([
			["hydrate", 1],
			["update", 2],
		]);
		// 记录关闭顺序：Harness 仍打开时，客户端先断开连接，服务随后撤销。
		const order: string[] = [];
		const trackedHarness = new Proxy(harness, {
			get: (target, key) => {
				const value = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (key !== "close") return value.bind(target);
				return async (closeContext: Context) => {
					order.push("close start");
					await target.close(closeContext);
					order.push("close end");
				};
			},
		});
		const trackedHost: FacetHost = {
			services: host.services,
			reload: (facets) => host.reload(facets),
			dispose: async () => {
				order.push("dispose start");
				await host.dispose();
				order.push("dispose end");
			},
		};
		await shutdown(
			trackedHost,
			async () => {
				order.push("detach start");
				await detach();
				order.push("detach end");
			},
			trackedHarness,
			context,
		);
		expect(order).toEqual(["detach start", "detach end", "dispose start", "dispose end", "close start", "close end"]);
		expect(() => host.services.use(Canvas)).toThrow("disposed");
		await expect(harness.commit(() => {}, context)).rejects.toThrow("closed");
	});

	it("runs the diff reviews with a keyed consumer", async () => {
		const { harness } = await openTasks(new MemoryStorage(), []);
		const root = await harness.root(context);
		const reviews = [{ key: "review-7", seed: { path: "a.ts", patch: "-old\n+new" } }];
		const seen: { key: string; comments: number }[] = [];
		const consumer = defineFacet({
			id: "app.diff-reviews/consumer",
			setup(env) {
				env.observe(DiffReviews, async (review, callContext) => {
					const { key } = await review.identity(callContext);
					review.state.subscribe((value) => void seen.push({ key, comments: value?.comments.length ?? -1 }));
					await review.addComment({ id: "c1", line: 1, text: "why?" }, callContext);
				});
			},
		});
		const host = await createFacetHost({ facets: [reviewFacet(harness, root.id, reviews, context), consumer] });
		await eventually(() => seen.some((frame) => frame.comments === 1));
		expect(seen).toEqual([
			{ key: "review-7", comments: 0 },
			{ key: "review-7", comments: 1 },
		]);
		expect(await harness.snapshot(ReviewDoc, root.id, "review-7", context)).toMatchObject({
			path: "a.ts",
			comments: [{ id: "c1" }],
		});
		await host.dispose();
		await harness.close(context);
	});

	it("runs the job output watch until the producer retires its document", async () => {
		logged.length = 0;
		sent.length = 0;
		rendered.length = 0;
		const gate = deferred();
		const Job = defineTask<JobInput, { phase: "running" }, null>({
			name: "app.job",
			version: 1,
			initial: () => ({ phase: "running" }),
			phases: {
				running: async (task, runtime, ctx) => {
					await appendJobOutput(runtime, `$ ${task.input.command}\n`, ctx);
					await gate.promise;
					await appendJobOutput(runtime, "ok\n", ctx);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async () => {},
		});
		const { harness } = await openTasks(new MemoryStorage(), [Job]);
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Job, { command: "make" }, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await eventually(async () => (await harness.snapshot(JobOutputDoc, id, context))?.chunks === 1);
		const finished = harness.waitForTask(id, context).then(() => {});
		const observing = observeJob(harness, id, finished, context);
		await eventually(() => logged.length === 1);
		gate.resolve();
		await observing;
		expect(logged).toEqual([["$ make\n"]]);
		// 任务结束后观察停止；此时可能已经发送了文档退役帧，也可能尚未发送。
		expect(rendered.slice(0, 1)).toEqual(["$ make\nok\n"]);
		expect(await harness.watchDoc(JobOutputDoc, id, context)).toBeUndefined();
		await harness.close(context);
	});
});
