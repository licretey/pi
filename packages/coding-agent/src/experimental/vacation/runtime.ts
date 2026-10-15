import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type Cursor,
	type EntryRecord,
	Harness,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type Submission,
	type TaskGraph,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import {
	configureHarnessHttp,
	createHarnessSettings,
	createVacationRegistry,
	findInitialAgentModel,
} from "./harness-setup.ts";
import { selectSession } from "./sessions.ts";
import { Vacation } from "./vacation.ts";

const context = BACKGROUND_CONTEXT;

export interface ModelSummary extends ModelRef {
	readonly name: string;
	readonly contextWindow: number;
}

export interface Notice {
	readonly id: number;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

/** 用户可以切换到的会话：主会话或子代理会话。 */
export interface ConversationSummary {
	readonly id: ConversationId;
	readonly label: string;
	/** 第一条用户消息；对子代理而言即其任务描述。 */
	readonly title?: string;
}

/** TUI 所需的全部渲染数据。均为普通值，不会有 Harness 对象跨越此边界。 */
export interface DurableView {
	readonly session: { readonly id: string; readonly directory: string; readonly cwd: string };
	/** 当前显示并用于交流的会话。 */
	readonly conversation: ConversationView;
	readonly conversations: readonly ConversationSummary[];
	readonly models: readonly ModelSummary[];
	readonly notices: readonly Notice[];
	/** 任务面板打开期间的实时任务图。 */
	readonly tasks?: TaskGraph;
}

export interface DurableViewSource {
	current(): DurableView;
	subscribe(listener: () => void): () => void;
}

/** TUI 可以发起的操作。 */
export interface DurableController {
	/** 空闲时提交提示词；忙碌时引导当前运行或排入后续输入。 */
	submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	/** 显示并切换到另一个会话。 */
	switchConversation(id: ConversationId): Promise<void>;
}

export interface OpenDurableOptions {
	readonly cwd?: string;
	readonly continueSession?: boolean;
}

export interface OpenDurableResult {
	readonly view: DurableViewSource;
	readonly controller: DurableController;
	/** pi 的设置，供 TUI 获取主题和终端能力信息。 */
	readonly settings: SettingsManager;
	close(): Promise<void>;
}

/** 视图对应的代理文档；会话尚无代理文档时为 undefined。 */
export function agentOf(view: ConversationView): AgentState {
	return (view.docs["pi.agent"] ?? {}) as AgentState;
}

/** 子代理的任务标题取自其会话中最早的用户消息；主会话无需标题。 */
async function firstInput(harness: Harness, id: ConversationId): Promise<{ title?: string }> {
	if (id === ROOT_CONVERSATION_ID) return {};
	const conversation = (await harness.conversation(id, context))!;
	let first: EntryRecord | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, 256, cursor, context);
		first = page.items.findLast((entry) => entry.kind === "pi.user") ?? first;
		cursor = page.next;
	} while (cursor !== undefined);
	return titleOf(first);
}

/** 用户条目的文本，用作单行标题。 */
function titleOf(entry: EntryRecord | undefined): { title?: string } {
	const message = entry?.model?.[0];
	if (message?.role !== "user") return {};
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
	return { title: text.replace(/\s+/g, " ").trim() };
}

export async function openDurable(options: OpenDurableOptions = {}): Promise<OpenDurableResult> {
	const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false);
	let harness: Harness | undefined;
	try {
		const modelRuntime = await ModelRuntime.create();
		const settingsManager = SettingsManager.create(location.cwd);
		configureHarnessHttp(settingsManager);
		const settings = createHarnessSettings(settingsManager);
		const registry = createVacationRegistry();

		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		harness = await Harness.open(
			await openNodeSqliteStorage(location.database),
			{
				models: modelRuntime,
				registry,
				settings,
				onReport: (error) => report(error),
			},
			context,
		);
		const initial = location.created ? await findInitialAgentModel(settingsManager, modelRuntime) : undefined;
		const root = await harness.root(context, {
			agent: {
				// 仅休假规划器使用此项；研究子代理会自行选择 search 工具。
				extensions: [Vacation],
				...(initial?.model === undefined ? {} : { model: initial.model }),
				...(initial?.thinkingLevel === undefined ? {} : { thinkingLevel: initial.thinkingLevel }),
			},
		});
		const label = (id: ConversationId): string => (id === root.id ? "main" : `subagent ${id}`);
		const opened = harness;
		const summaries: ConversationSummary[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await opened.commit((tx) => tx.scanConversations({}, 256, cursor), context);
			for (const { id } of page.items) summaries.push({ id, label: label(id), ...(await firstInput(opened, id)) });
			cursor = page.next;
		} while (cursor !== undefined);
		let current: Conversation = root;
		let conversation: AttachedReplicatedState<ConversationView> = await root.viewState(context);
		const models = (): ModelSummary[] =>
			modelRuntime.getAvailableSnapshot().map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
			}));

		let state: DurableView = {
			session: { id: location.id, directory: location.directory, cwd: location.cwd },
			conversation: conversation.value,
			conversations: summaries,
			models: models(),
			notices: [],
		};
		const listeners = new Set<() => void>();
		let notifying = false;
		// 提交监听器和 Chord 帧会在 Session 执行通道中调用此函数；之后每批事件只进行一次渲染。
		const update = (patch: Partial<DurableView>): void => {
			state = { ...state, ...patch };
			if (notifying) return;
			notifying = true;
			setImmediate(() => {
				notifying = false;
				for (const listener of listeners) listener();
			});
		};
		let nextNotice = 1;
		const notice = (level: Notice["level"], message: string): void => {
			update({ notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20) });
		};
		const fail = (error: unknown): void => notice("error", error instanceof Error ? error.message : String(error));
		report = (error) => notice("warning", error instanceof Error ? error.message : String(error));
		for (const error of pendingReports) report(error);
		let unsubscribe = conversation.subscribe((value) => update({ conversation: value }));
		// 子代理会随其会话创建而显示。提交监听器只记录状态，不调用任何 Session API。
		const unsubscribeCommits = harness.subscribeCommits((publication) => {
			let conversations = state.conversations;
			for (const change of publication.changes) {
				if (change.type === "conversation") {
					conversations = [...conversations, { id: change.value.id, label: label(change.value.id) }];
				} else if (change.type === "entry" && change.value.kind === "pi.user") {
					const id = change.value.conversationId;
					conversations = conversations.map((summary) =>
						summary.id === id && summary.title === undefined ? { ...summary, ...titleOf(change.value) } : summary,
					);
				}
			}
			if (conversations !== state.conversations) update({ conversations });
		});

		let tasks: AttachedReplicatedState<TaskGraph> | undefined;
		let unsubscribeTasks = (): void => {};
		const closeTasks = (): void => {
			unsubscribeTasks();
			tasks?.dispose();
			tasks = undefined;
		};

		let queue = Promise.resolve();
		// 操作逐个执行，确保切换、跳转和按键按顺序生效。
		const command = (operation: () => Promise<void>): Promise<void> => {
			queue = queue.then(operation).catch(fail);
			return queue;
		};
		const watchAnswer = (submission: Submission): void => {
			void submission.wait(context).then((settled) => {
				if (settled.status === "unanswered" && settled.reason !== "aborted") {
					notice(
						"error",
						`No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`,
					);
				}
			}, fail);
		};
		const agentModel = () => {
			const ref = agentOf(state.conversation).model;
			const model = ref === undefined ? undefined : modelRuntime.getModel(ref.provider, ref.modelId);
			if (model === undefined)
				throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable");
			return model;
		};
		const controller: DurableController = {
			submit: (text, whenBusy) =>
				command(async () => watchAnswer(await current.submit({ type: "input", content: text, whenBusy }, context))),
			compact: (instructions) =>
				command(async () => {
					const id = await current.compact(instructions, context);
					// 结果确定后再报告；等待期间，状态栏会显示压缩状态。
					void opened.waitForTask(id, context).then(async (receipt) => {
						const outcome = receipt.state.outcome;
						if (outcome.status === "completed") {
							const { entryId, submissionId } = outcome.result;
							// 忙碌时写入的摘要会作为提交处理：立即放入、排队等待或因过期而丢弃。
							const status =
								submissionId === undefined
									? undefined
									: (await (await opened.submission(submissionId, context))?.status(context))?.status;
							notice(
								"info",
								entryId !== undefined || status === "done"
									? "Compacted."
									: status === "queued"
										? "Compaction summary queued; it is placed at the next turn boundary."
										: status === "unanswered"
											? "Compaction summary dropped: the context changed under it."
											: "Nothing to compact: the context fits in the recent window that is kept verbatim.",
							);
						} else if (outcome.status === "aborted") notice("info", "Compaction aborted.");
						else
							notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
					}, fail);
				}),
			// 不排队：等待会话空闲后再处理。
			abort: () => current.abort(context).catch(fail),
			cycleThinking: () =>
				command(async () => {
					const model = agentModel();
					if (!model.reasoning) throw new Error("Current model does not support thinking");
					const levels = getSupportedThinkingLevels(model);
					const level = agentOf(state.conversation).thinkingLevel ?? "off";
					const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
					await current.configure({ thinkingLevel: next }, context);
				}),
			setModel: (ref) =>
				command(async () => {
					const model = modelRuntime.getModel(ref.provider, ref.modelId);
					if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
					const thinking: ModelThinkingLevel = agentOf(state.conversation).thinkingLevel ?? "off";
					await current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
				}),
			toggleTasks: () =>
				command(async () => {
					if (tasks !== undefined) {
						closeTasks();
						update({ tasks: undefined });
						return;
					}
					const graph = await opened.taskGraph(context);
					tasks = graph;
					unsubscribeTasks = graph.subscribe((value) => update({ tasks: value }));
				}),
			switchConversation: (id) =>
				command(async () => {
					const next = await opened.conversation(id, context);
					if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
					const nextState = await next.viewState(context);
					unsubscribe();
					conversation.dispose();
					current = next;
					conversation = nextState;
					unsubscribe = nextState.subscribe((value) => update({ conversation: value }));
				}),
		};

		const saved = agentOf(state.conversation).model;
		if (saved === undefined) notice("warning", "No model configured; select one with /model.");
		else if (modelRuntime.getModel(saved.provider, saved.modelId) === undefined) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		if (initial?.fallbackMessage !== undefined) notice("info", initial.fallbackMessage);
		// 任务面板默认打开；输入 /tasks 可将其隐藏。
		await controller.toggleTasks();
		// 现在继续处理从中断回合中恢复的工作。
		harness.resume();

		let closing: Promise<void> | undefined;
		return {
			view: {
				current: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			controller,
			settings: settingsManager,
			close() {
				closing ??= (async () => {
					unsubscribe();
					unsubscribeCommits();
					conversation.dispose();
					closeTasks();
					try {
						// 关闭时不会写入结果：运行中的回合会通过 --continue 恢复。
						await opened.close(context);
					} finally {
						await location.release();
					}
				})();
				return closing;
			},
		};
	} catch (error) {
		await harness?.close(context).catch(() => {});
		await location.release().catch(() => {});
		throw error;
	}
}
