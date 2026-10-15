// 持久化的后台子智能体。主智能体可通过 `subagent` 工具启动具名子智能体、向其发送消息（引导或追加跟进）、
// 在回答过程中停止它们，并查看它们的状态。主智能体回答用户期间，子智能体仍会继续工作；回答完成后会作为新消息送回主智能体。
// 所有状态都能跨进程重启保留：本示例会在子智能体工作期间关闭并重新打开 Harness。
// 设置 OPENAI_API_KEY 时使用 OpenAI，否则使用脚本化的模拟模型。
// 在 packages/durable 目录下运行：
//   node --conditions=source --experimental-strip-types test/examples/23-subagent-background.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type FauxResponseStep, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	Harness,
	LiveDoc,
	type TaskId,
	watchEvents,
} from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

// ─── 产品代码 ───────────────────────────────────────────────────────────────

// 每个子智能体都有独立会话和对话记录，因此能记住之前的消息。主会话通过一个小型文档保存子智能体名称与会话的对应关系。
// 文档与对话记录一样属于持久化状态，并通过提交进行修改。
type Subagent = {
	conversationId: ConversationId;
	/** 已向主智能体报告的回答：多条消息可能合并为一个回答，并且只报告一次。 */
	reported: EntryId[];
};
const Subagents = defineDoc<{ agents: Record<string, Subagent>; reporters: Record<string, TaskId> }>({
	kind: "app.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	// 主会话的分支不会继承子智能体。
	fork: "initial",
	initial: () => ({ agents: {}, reporters: {} }),
});

// 每个任务和会话都有所有者，这决定中止或等待空闲会影响哪些工作：中止任务会中止它拥有的工作；等待会话空闲则会等待该会话中的工作。
// 子智能体必须在主智能体轮次结束后继续运行，因此其会话由一个立即完成的后台锚点任务拥有。后台任务会形成边界：
// 主智能体的 Esc 操作和空闲等待到此为止，但 `abort({ background: true })` 仍会越过边界，使宿主能够停止所有工作。
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "app.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
	},
	abort: (_anchor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

// reporter 任务向子智能体发送一条消息，并将回答转告主智能体。它也是后台任务，因此主智能体的 Esc 操作和空闲等待不会影响它。
// 任务状态会持久化：每个阶段结束时都会保存检查点，重启后从最近的检查点继续。重复提交时，请求 ID 会返回首次创建的提交，
// 因而子智能体只收到一次消息，主智能体也只收到一次汇报。
type ReporterInput = { name: string; conversationId: ConversationId; message: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };
const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "app.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		// 发送消息、等待回答，并决定要汇报的内容。
		deliver: async (reporter, runtime, taskContext) => {
			const { name, conversationId, message, followUp } = reporter.input;
			// 子智能体忙碌时，steer 会在它的下一步送达；follow-up 则会在当前回答完成后送达。
			const subagent = (await runtime.conversation(conversationId, taskContext))!;
			const request = { type: "input", content: message, whenBusy: followUp ? "followUp" : "steer" } as const;
			const submission = await subagent.submit({ ...request, requestId: `subagent:${reporter.id}` }, taskContext);
			const settled = await submission.wait(taskContext);
			// 在同一次提交中决定汇报内容并记录回答已送达，避免重启后再次决定。
			await runtime.commit(async (tx) => {
				const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				// `aborted` 表示任务已停止或在排队时被撤回，无需汇报内容。
				if (settled.status === "unanswered") {
					return next(settled.reason === "aborted" ? undefined : `[subagent ${name} failed: ${settled.reason}]`);
				}
				// 此处应始终是已回答的输入；该检查用于满足 TypeScript 的类型判断。
				if (settled.type !== "input") return next();
				const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name]!;
				if (agent.reported.includes(settled.answer)) return next();
				agent.reported.push(settled.answer);
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage;
				return next(`[subagent ${name} answered, no reply needed] ${textOf(answer)}`);
			}, taskContext);
		},
		// 将汇报作为 follow-up 输入提交：主智能体空闲时会开启新轮次，否则等待当前回答结束。
		// 若它在主智能体队列中等待时用户按下 Esc，就会像其他输入一样被丢弃；Esc 之后到达的汇报则会开启新轮次。
		report: async (reporter, runtime, taskContext) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const main = (await runtime.conversation(runtime.conversationId, taskContext))!;
				const input = { type: "input", content: report, whenBusy: "followUp" } as const;
				await main.submit({ ...input, requestId: `subagent-report:${reporter.id}` }, taskContext);
			}
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
				taskContext,
			);
		},
	},
	abort: (_reporter, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

const subagentTool = defineTool({
	name: "subagent",
	description:
		"Manage persistent subagents that work in the background. Actions: spawn (name, message), send (name, message; " +
		"followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), " +
		"status (name, or all subagents without one). Answers are reported back to you when they arrive.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("spawn"), Type.Literal("send"), Type.Literal("stop"), Type.Literal("status")]),
		name: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		followUp: Type.Optional(Type.Boolean()),
	}),
	// 因崩溃而中断的调用不会重试：重复执行 `stop` 可能会停止更新的工作。模型会得知调用已中断，并可通过 `status` 查询状态。
	replay: "unsafe",
	execute: async (args, api, callContext) => {
		const { action, name, message, followUp } = args;
		const reply = (text: string, conversationId?: ConversationId) => ({
			content: [{ type: "text" as const, text }],
			// 界面可以通过调用详情连接到子智能体的会话。
			...(conversationId === undefined || name === undefined ? {} : { details: { name, conversationId } }),
		});
		const registry = (await api.snapshot(Subagents, api.conversationId, callContext)) ?? {
			agents: {},
			reporters: {},
		};

		if (action === "status") {
			const names = name === undefined ? Object.keys(registry.agents) : [name];
			const lines: string[] = [];
			for (const each of names) {
				const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : undefined;
				if (found === undefined) continue;
				// 会话从收到输入开始，到最终回答完成为止都处于忙碌状态。
				const busy = (await api.snapshot(LiveDoc, found.conversationId, callContext))?.run !== undefined;
				lines.push(`${each}: ${busy ? "working" : "idle"}`);
			}
			return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
		}
		if (name === undefined) return reply(`${action} needs a name.`);
		const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;
		if (action !== "spawn" && agent === undefined) return reply(`No subagent named ${name}.`);

		if (action === "stop") {
			// 中止子智能体当前的回答和工具调用，并丢弃排队中的消息；子智能体仍可继续使用。
			await (await api.conversation(agent!.conversationId, callContext))!.abort(callContext);
			return reply(`Stopped ${name}.`, agent!.conversationId);
		}
		if (message === undefined) return reply(`${action} needs a message.`);

		// spawn 和 send 都会在一次提交中为消息创建 reporter 任务。
		const result = await api.commit(async (tx) => {
			const state = await tx.doc(Subagents, api.conversationId);
			// 两类任务都由主会话拥有且属于后台任务：主会话的 Esc 操作和空闲等待会跳过它们。
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			if (action === "spawn") {
				if (Object.hasOwn(state.agents, name)) return `${name} already exists; use send.`;
				const anchor = await tx.createTask(Anchor, null, background);
				// 由主会话中的任务拥有：初始配置复制自主 agent。
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
				// 子智能体不能再启动子智能体，并且会收到自己的身份说明。
				await configure(tx, child.id, {
					extensions: { remove: [SubagentTools] },
					instructions: `You are the subagent "${name}". Answer the main agent's requests.`,
				});
				state.agents[name] = { conversationId: child.id, reported: [] };
			}
			const conversationId = state.agents[name]!.conversationId;
			const input = { name, conversationId, message, followUp: action === "send" && followUp === true };
			state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
			return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
		}, callContext);
		const current = (await api.snapshot(Subagents, api.conversationId, callContext))?.agents[name];
		return reply(result, current?.conversationId);
	},
});

// 任务定义随扩展一同提供；宿主重启后重新安装扩展，等待中的 reporter 任务就会恢复运行。
const SubagentTools = defineExtension({ name: "subagent-tools", tasks: [Anchor, Reporter], tools: [subagentTool] });

// ─── 宿主环境设置 ───────────────────────────────────────────────────────────

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	models.setProvider(openaiProvider());
} else {
	// 主智能体和子智能体共用一个脚本化模型，该模型根据请求中的最后一条消息作答。
	// 它以每秒 50 个令牌的速度流式生成回答，模拟速度较慢的真实模型。
	const faux = fauxProvider({ tokensPerSecond: 50 });
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	const call = (input: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall("subagent", input)], { stopReason: "toolUse" });
	const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
	const route: FauxResponseStep = (request) => {
		// system 消息携带提示词更改；当前请求对应它们之前的那条消息。
		const last = request.messages.findLast((message) => message.role !== "system")!;
		const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		// 主智能体复述工具返回的内容。
		if (last.role === "toolResult") return answer(`OK. ${text}`);
		// 主智能体。
		if (text.includes("Start a subagent")) {
			return call({ action: "spawn", name: "reader", message: "Summarize the plot of Moby Dick." });
		}
		if (text.includes("whale's name"))
			return call({ action: "send", name: "reader", message: "What is the whale called?" });
		if (text.includes("every chapter")) {
			return call({ action: "send", name: "reader", message: "Now go through all chapters in detail." });
		}
		if (text.includes("Stop reader")) return call({ action: "stop", name: "reader" });
		if (text.includes("my subagents")) return call({ action: "status" });
		if (text.includes("[subagent")) return answer("Noted.");
		// 子智能体：先给出简短回答，再生成一段中途停止的长篇章节讲解。
		if (text.includes("Summarize the plot")) return answer("A whale, a captain, an obsession.");
		if (text.includes("whale called")) return answer("Moby Dick.");
		const chapters = Array.from({ length: 135 }, (_, index) => `Chapter ${index + 1}: more whaling.`);
		return answer(chapters.join("\n"));
	};
	// 响应数量多于脚本所需；每次请求都会依次取用下一条响应。
	faux.setResponses(Array.from({ length: 40 }, () => route));
}
const registry = createRegistry();
registry.install(SubagentTools);
const directory = await mkdtemp(join(tmpdir(), "pi-durable-subagents-"));
const open = async () => {
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models, registry },
		context,
	);
	const root = await harness.root(context, { agent: { model } });
	return { harness, root };
};

// ─── 界面：用户看到的主对话记录 ───

const color = (code: number) => (text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color(1);
const dim = color(2);
const cyan = color(36);
const yellow = color(33);
const magenta = color(35);

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("");
}

/** 每次提交后打印主会话的消息。子智能体在各自独立的会话中工作。 */
async function follow(harness: Harness, id: ConversationId): Promise<void> {
	const stream = await watchEvents(harness, id, context);
	stream.start(async (events: readonly AgentEvent[]) => {
		for (const event of events) {
			if (event.type !== "message_end") continue;
			const message = event.entry.model?.[0];
			if (message?.role === "user") {
				const text = contentText(message.content);
				// 输入可能来自用户，也可能是子智能体完成工作后送达的汇报。
				const report = /^\[subagent (\S+) ([^\]]*)\] ?(.*)$/s.exec(text);
				if (report === null) console.log(`\n${cyan(bold(">"))} ${bold(text)}`);
				else console.log(`\n${magenta(bold(`> ${report[1]}:`))} ${report[3] || report[2]}`);
			} else if (message?.role === "assistant") {
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const { action, name, message: sent } = part.arguments as Record<string, string | undefined>;
					const quoted = sent === undefined ? "" : ` ${JSON.stringify(sent)}`;
					console.log(yellow(`  ${part.name} ${action}${name === undefined ? "" : ` ${name}`}${quoted}`));
				}
				if (textOf(message) !== "") console.log(textOf(message));
			} else if (message?.role === "toolResult") {
				console.log(dim(`  → ${contentText(message.content)}`));
			}
		}
	});
}

let { harness, root } = await open();
await follow(harness, root.id);

/** 向主智能体发送消息并等待回答。 */
const say = async (text: string): Promise<void> => {
	await (await root.submit({ type: "input", content: text }, context)).wait(context);
};
/** 等待发给子智能体的所有消息都得到回答并完成汇报，且主智能体已作出响应。 */
const settle = async (): Promise<void> => {
	const reporters = (await harness.snapshot(Subagents, root.id, context))?.reporters ?? {};
	for (const id of Object.values(reporters)) await harness.waitForTask(id, context);
	await root.waitForIdle(context);
	// 事件回调会在提交后运行；等待最后几条事件打印完毕。较慢的机器可能需要更长时间。
	await new Promise((resolve) => setTimeout(resolve, 50));
};
/** 最多轮询 `check` 10 秒。 */
const until = async (check: () => Promise<boolean>): Promise<void> => {
	for (let tries = 0; tries < 1000 && !(await check()); tries++)
		await new Promise((resolve) => setTimeout(resolve, 10));
};
const working = async (name: string): Promise<boolean> => {
	const agent = (await harness.snapshot(Subagents, root.id, context))?.agents[name];
	return agent !== undefined && (await harness.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
};

// 主智能体会立即作答；子智能体的回答将在完成后送回主智能体。
await say("Start a subagent named reader that summarizes Moby Dick.");
await settle();

// 发出一项耗时较长的请求，并在子智能体仍在回答时将其停止。
await say("Ask reader to summarize every chapter.");
await until(() => working("reader"));
await say("Stop reader.");
await settle();

await say("What are my subagents doing?");
await settle();

// 子智能体处理消息期间进程退出；重启后仍会收到它的回答。
const reporters = async () =>
	Object.keys((await harness.snapshot(Subagents, root.id, context))?.reporters ?? {}).length;
const before = await reporters();
await root.submit({ type: "input", content: "Ask reader for the whale's name." }, context);
await until(async () => (await reporters()) > before);
await harness.close(context);
console.log(dim("\n  (process restarts)"));
({ harness, root } = await open());
await follow(harness, root.id);
await settle();

await harness.close(context);
await rm(directory, { recursive: true, force: true });
