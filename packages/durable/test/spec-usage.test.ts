/**
 * 对 docs/spec.md 中的用法示例进行编译检查。每个代码块都按文档内容复制，仅调整格式，
 * 并在下方声明规范留给应用定义的名称。两者应保持同步；`test/examples/` 会端到端运行相同模式。
 */
import type { Context, Draft } from "@earendil-works/chord";
import { type AssistantMessage, type Models, type ToolCall, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	GenerationTask,
	Harness,
	type HarnessSettings,
	type HookApi,
	hook,
	LiveDoc,
	type LiveState,
	type Session,
	type Storage,
	section,
	type TaskId,
	type ToolExecutionApi,
	ToolTask,
	type Tx,
	type UserInput,
	wrapTool,
} from "@earendil-works/pi-durable";
import { expect, expectTypeOf, it } from "vitest";
import type { ExecutionEnv } from "../src/env/index.ts";
import { CodingTools, createBashTool, createEditTool, createReadTool } from "../src/tools/index.ts";

// ─── 规范留给应用自行定义的名称 ───────────────────────────────────────────────

declare const context: Context;
declare const storage: Storage;
declare const models: Models;
declare const session: Session;
declare const conversationId: ConversationId;
declare const message: { readonly kind: string };
declare const haiku: { readonly provider: string; readonly modelId: string };
declare const sonnet: { readonly provider: string; readonly modelId: string };
declare const worktree: string;
declare const name: string;
declare function localEnv(cwd: string): ExecutionEnv;
declare const containers: { env(image: string, cwd: string, context: Context): Promise<ExecutionEnv> };
declare function renderAgentsMd(): string | undefined;
declare function renderSkills(): string | undefined;
declare function isDangerous(call: ToolCall): boolean;
declare function writes(call: ToolCall): boolean;
declare function requestSecondPass(
	answer: AssistantMessage,
	api: HookApi,
	context: Context,
): Promise<{ readonly continue: UserInput } | undefined>;
declare const metrics: { record(name: string, ms: number): void };
declare function answerText(api: ToolExecutionApi, entry: EntryId, context: Context): Promise<string>;
declare const payments: {
	charge(key: string): Promise<{ id: string }>;
	cancel(checkpoint: { phase: string }): Promise<void>;
};
declare function newKey(): string;
declare function receiptEntry(receipt: { id: string }): { kind: string; data: { id: string } };
interface SettingsManager {
	get(key: "timeoutMs"): number;
	get(key: "autoCompact"): boolean;
	set(key: "autoCompact", value: boolean): void;
}
declare const manager: SettingsManager;
declare const Anchor: ReturnType<typeof defineTask<null, { phase: "hold" }, null>>;
declare const Reporter: ReturnType<typeof defineTask<null, { phase: "report" }, null>>;
declare const subagentTool: ReturnType<typeof createReadTool>;

/** 不会调用：上方声明的名称没有实际值。 */
function examples() {
	const readTool = createReadTool();
	const editTool = createEditTool();
	const bashTool = createBashTool();

	// ─── 第 7.1 节：扩展与宿主设置 ───────────────────────────────────────────────

	const ContextFiles = defineExtension({ name: "context-files", sections: [section("agents-md", renderAgentsMd)] });
	const Skills = defineExtension({ name: "skills", sections: [section("skills", renderSkills)] });
	const SkillsV2 = defineExtension({ name: "skills", sections: [section("skills", renderSkills)] });
	const Coding = defineExtension({
		name: "coding",
		sections: [
			section("preamble", () => "You are an expert coding assistant.", { tag: false }),
			// 宿主在该对话所在目录中为其创建的环境。
			section("cwd", (input) => input.env && `Working directory: ${input.env.cwd}`),
		],
	});
	const Permissions = defineExtension({
		name: "permissions",
		hooks: [
			hook(ToolTask, { beforeTool: async (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) }),
		],
	});
	// 为选择它的对话提供角色和审查循环。
	const Reviewer = defineExtension({
		name: "reviewer",
		sections: [section("role", () => "You review diffs. Report problems as a list. Never edit files.")],
		hooks: [hook(GenerationTask, { onYield: requestSecondPass })],
	});

	const Timing = defineExtension({
		name: "timing",
		wraps: [
			wrapTool(bashTool, (tool) => ({
				...tool,
				execute: async (args, api, context) => {
					const start = Date.now();
					try {
						return await tool.execute(args, api, context);
					} finally {
						metrics.record("bash", Date.now() - start);
					}
				},
			})),
		],
	});
	// 为单个对话提供 Python 虚拟环境中的 bash：在原位置替换 CodingTools 的 bash；
	// 若选中了 Timing 扩展，则由它包装该工具。
	const Venv = defineExtension({
		name: "venv",
		tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
	});

	// ─── 第 7.2 节：读取扩展状态的钩子 ───────────────────────────────────────────

	const PlanModeDoc = defineDoc<{ enabled: boolean }>({
		kind: "app.plan-mode",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({ enabled: false }),
	});
	const PlanMode = defineExtension({
		name: "plan-mode",
		hooks: [
			hook(ToolTask, {
				// 文档不存在表示计划模式已关闭。
				beforeTool: async (call, api, context) =>
					(await api.snapshot(PlanModeDoc, api.conversationId, context))?.enabled && writes(call)
						? { block: "Plan mode: read-only" }
						: undefined,
			}),
		],
	});

	// ─── 第 7.3 节：子智能体 ─────────────────────────────────────────────────────

	const Subagent = defineExtension({
		name: "subagent",
		tools: [
			defineTool({
				name: "subagent",
				description: "Delegate a self-contained task to a subagent and get its answer back.",
				parameters: Type.Object({ task: Type.String() }),
				replay: "safe",
				execute: async (args, api, context) => {
					const { task } = args;
					const child = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						// 以当前对话的 agent 副本开始：包含模型、思考级别、cwd、扩展和工具。
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						// 没有此扩展时，不会向子任务提供该工具。
						await configure(tx, created.id, { extensions: { remove: [Subagent] } });
						return created.id;
					}, context);
					await api.details({ conversationId: child }, context);
					const handle = (await api.conversation(child, context))!;
					const request = { type: "input", content: task, requestId: `subagent:${api.taskId}` } as const;
					const settled = await (await handle.submit(request, context)).wait(context);
					if (settled.status !== "done" || settled.type !== "input")
						throw new Error(`Subagent failed: ${settled.status}`);
					return { output: [{ type: "text", text: await answerText(api, settled.answer, context) }] };
				},
			}),
		],
	});

	const SubagentTools = defineExtension({ name: "subagent-tools", tasks: [Anchor, Reporter], tools: [subagentTool] });

	// ─── 第 7.4 节 ───────────────────────────────────────────────────────────────

	const Chat = defineExtension({
		name: "chat",
		sections: [section("preamble", () => "You are a helpful assistant.", { tag: false })],
	});

	// ─── 第 5.1 节：包含意图、效果和结果的任务 ────────────────────────────────────

	type Charge = { phase: "prepare" } | { phase: "charge"; key: string };
	const Payment = defineTask<null, Charge, { entryId: EntryId }>({
		name: "app.payment",
		version: 1,
		initial: () => ({ phase: "prepare" }),
		phases: {
			// 意图、效果、结果。
			prepare: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "charge", key: newKey() } }),
					context,
				);
			},
			charge: async (task, runtime, context) => {
				const receipt = await payments.charge(task.state.checkpoint.key); // idempotent by key
				await runtime.commit(async (tx, current) => {
					const entry = await tx.appendEntry(current.conversationId, receiptEntry(receipt));
					return { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
				}, context);
			},
		},
		// 由中止处理器决定结果；未提供处理器就返回会导致任务失败。
		abort: async (task, runtime, context) => {
			await payments.cancel(task.state.checkpoint);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "user" } }), context);
		},
	});

	const Follow = defineTask<object, { phase: "follow" }, null>({
		name: "app.follow",
		version: 1,
		initial: () => ({ phase: "follow" }),
		phases: { follow: async () => {} },
		abort: async () => {},
	});

	// ─── Sequences ───────────────────────────────────────────────────────────────

	const sequences = {
		// 第 2.2 节：工具的提交会创建已配置的子任务。
		childInToolCommit: async (tx: Tx, api: { readonly taskId: TaskId }) => {
			// 在工具的提交操作中创建。子任务以当前对话 agent 的副本开始：包含模型、扩展、工具和 cwd。
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			// 使用更便宜的模型、仅提供 read 工具并使用独立工作树；其他配置均沿用副本中的设置。
			await configure(tx, child.id, { model: haiku, tools: [readTool], cwd: worktree });
		},

		// 第 2.2 节：设置通过 getter 实时读取。
		liveSettings: () => {
			// 用户设置通过 getter 实时读取。
			class UserSettings implements HarnessSettings {
				readonly manager: SettingsManager;
				constructor(manager: SettingsManager) {
					this.manager = manager;
				}
				get stream() {
					return { timeoutMs: this.manager.get("timeoutMs") };
				}
				get compaction() {
					return { enabled: this.manager.get("autoCompact") };
				}
			}
			manager.set("autoCompact", false); // 不写入 Session；每个 conversation 会在下次检查阈值时应用该设置。
			return new UserSettings(manager);
		},

		// 第 2.2 节：每个 conversation 使用独立环境。
		containerEnv: async () => {
			const registry = createRegistry();
			// 文档不存在时，对话在本地运行。只有包含该文档的对话会在容器中运行。
			// 子代理不会复制此文档；如果子代理也应在容器中运行，其创建方也必须写入该文档。
			const ContainerDoc = defineDoc<{ image: string }>({
				kind: "app.container",
				version: 1,
				scope: "conversation",
				history: "latest",
				fork: "current",
				initial: () => ({ image: "node:22" }),
			});
			const harness = await Harness.open(
				storage,
				{
					models,
					registry,
					env: async ({ conversationId, cwd, read }, context) => {
						const container = await read.snapshot(ContainerDoc, conversationId, context);
						return container !== undefined
							? containers.env(container.image, cwd ?? "/work", context)
							: localEnv(cwd ?? process.cwd()); // cached NodeExecutionEnv per directory
					},
				},
				context,
			);
			return harness;
		},

		// 第 2.2 和 7.1 节：宿主设置、工具筛选、扩展选择、计划模式和重新加载。
		host: async () => {
			const registry = createRegistry();
			for (const extension of [CodingTools, Coding, ContextFiles, Skills, Permissions, Reviewer]) {
				registry.install(extension);
			}
			const harness = await Harness.open(
				storage,
				{
					models,
					registry,
					// Reviewer 已安装但默认未选中：只有选择它的对话才会获得其角色和钩子。
					settings: { extensions: [CodingTools, Coding, ContextFiles, Skills, Permissions] },
					env: ({ cwd }) => localEnv(cwd ?? process.cwd()), // cached NodeExecutionEnv per directory
				},
				context,
			);
			// 对话会记住所用模型和目录；即使在其他位置重启，这两项也会保留。
			const root = await harness.root(context, { agent: { model: sonnet, cwd: process.cwd() } });

			await root.configure({ tools: { remove: [editTool] } }, context);
			await root.configure({ tools: { remove: [bashTool] } }, context); // 再次提供 edit 工具。
			await root.configure({ tools: null }, context); // 再次提供所选扩展中的全部工具。

			registry.install(Timing);
			registry.install(Venv); // 已安装，但不在默认选择范围内。
			const conversation = root;
			await conversation.configure({ extensions: { add: [Venv] } }, context);

			registry.install(PlanMode);
			// PlanMode 默认处于选中状态；/plan 用于切换当前对话的状态。
			await root.commit(async (tx) => {
				(await tx.doc(PlanModeDoc, root.id)).enabled = true;
			}, context);

			registry.install(Subagent);
			registry.install(Chat);
			registry.install(SkillsV2); // 名称相同：选择 skills 的 conversation 会在下次请求时渲染 v2。
			registry.uninstall(Skills); // 选用了该技能的 conversation 会收到移除对应区段的系统增量，不会重写已有内容。
			// 重启时，宿主会重新安装扩展；存储的名称会根据这些扩展重新解析。
			return harness;
		},

		// 第 7.3 节：命名子智能体的启动提交。
		spawn: async (tx: Tx) => {
			// 在 subagentTool 的生成提交中，名称检查之后：
			const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
			// 由父级任务拥有：以父级 agent 的副本开始运行。
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, child.id, {
				extensions: { remove: [SubagentTools] },
				instructions: `You are the subagent "${name}". Answer the main agent's requests.`,
			});
		},

		// 第 4 节：首次写入表之前先读取表；文档仍可继续使用。
		tableRules: async () => {
			await session.commit(async (tx) => {
				const conversation = await tx.conversation(conversationId); // 读取表项。
				const live = await tx.doc(LiveDoc, conversationId);

				await tx.appendEntry(conversationId, message); // 首次写入表项。
				delete live.generation; // document mutation remains valid
				await tx.createTask(Follow, {}, { ownership: { kind: "conversation" }, conversationId }); // 后续仍可继续写入表项。
				void conversation;
			}, context);
		},

		// 第 3.4 节：草稿在提交后失效。
		revokedDraft: async () => {
			let escaped: Draft<LiveState> | undefined;
			await session.commit(async (tx) => {
				escaped = await tx.doc(LiveDoc, conversationId);
			}, context);
			escaped!.generation = undefined; // 草稿已撤销，因此此处会抛出异常。
		},
	};
	return { sequences, Payment };
}

it("compiles the spec's usage examples", () => {
	expectTypeOf(examples).returns.toHaveProperty("sequences");
	expect(examples).toBeTypeOf("function");
});
