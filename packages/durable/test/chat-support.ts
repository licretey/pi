import type { Context } from "@earendil-works/chord";
import {
	createModels,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxProvider,
	type Message,
	type Models,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	type EntryRecord,
	Harness,
	type HarnessOptions,
	type HarnessSettings,
	type Registry,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "../src/env/index.ts";
import { context } from "./session-support.ts";

/** 关闭并重新打开 Harness 后仍保留的模型和注册表，如同宿主进程自身持有的对象。 */
export type ChatSetup = {
	readonly faux: FauxProviderHandle;
	readonly models: Models;
	readonly registry: Registry;
	readonly reports: unknown[];
	/** 当前 Harness 设置；测试会赋值修改这些字段，以便在不同决策之间切换设置。 */
	readonly settings: { -readonly [K in keyof HarnessSettings]: HarnessSettings[K] };
	now: () => number;
};

export function chatSetup(options: RegisterFauxProviderOptions = {}): ChatSetup {
	const faux = fauxProvider(options);
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models, registry: createRegistry(), reports: [], settings: {}, now: () => Date.now() };
}

/** 基于 `storage` 打开 Harness 并返回根对话；首次创建时将其配置为使用 faux 模型。 */
export async function openChat(
	storage: Storage,
	setup: ChatSetup,
	/** 所有对话共用的环境，或用于按需提供环境的 `env` 函数。 */
	options: { readonly env?: ExecutionEnv | NonNullable<HarnessOptions["env"]> } = {},
): Promise<{ readonly harness: Harness; readonly root: Conversation }> {
	const harness = await Harness.open(
		storage,
		{
			models: setup.models,
			registry: setup.registry,
			settings: setup.settings,
			...(options.env === undefined
				? {}
				: { env: typeof options.env === "function" ? options.env : () => options.env as ExecutionEnv }),
			now: () => setup.now(),
			onReport: (error) => setup.reports.push(error),
		},
		context,
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { harness, root };
}

/** 按时间从旧到新返回对话的原始条目。 */
export async function allEntries(conversation: Conversation, callContext: Context = context): Promise<EntryRecord[]> {
	const page = await conversation.entries({}, 1000, undefined, callContext);
	return [...page.items].reverse();
}

/** 返回消息中第一段文本内容。 */
export function textOf(message: Message | undefined): string | undefined {
	if (message === undefined) return undefined;
	if (message.role === "system") return undefined;
	if (typeof message.content === "string") return message.content;
	const text = message.content.find((content) => content.type === "text");
	return text?.type === "text" ? text.text : undefined;
}

/** 实时轮询 `check`，直到条件成立；适用于等待时间跨越节流窗口和定时器的场景。 */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Condition was not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * 永不返回答案的 faux 响应；生成过程会一直保持忙碌，直到被取消。生成过程完成准备和请求提交并发出请求后，
 * `reached` 就会兑现。
 */
export function unanswered(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	const step: FauxResponseStep = (_context, options) =>
		new Promise((_, reject) => {
			reach();
			const signal = options!.signal!;
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	return { step, reached };
}

/** 从已安装工具中按名称查找 `configure()` 所需的工具。 */
export function toolsNamed(setup: ChatSetup, ...names: string[]): ToolRegistration[] {
	const installed = setup.registry.snapshot().tools();
	return names.map((name) => {
		const found = installed.find(({ tool }) => tool.name === name);
		if (found === undefined) throw new Error(`Tool ${name} is not installed`);
		return found.tool;
	});
}
