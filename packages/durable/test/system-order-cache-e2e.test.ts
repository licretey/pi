import {
	type AssistantMessage,
	type Message,
	type Model,
	type Models,
	normalizeContext,
	Type,
	uuidv7,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleAnthropic } from "../../ai/src/api/anthropic-messages.ts";
import { resolveApiKey } from "../../ai/test/oauth.ts";
import { context } from "./session-support.ts";

const anthropicToken = await resolveApiKey("anthropic");

/** 设置两项对话中途兼容标志，使工具变更在允许时使用 Anthropic 原生的追加机制。 */
const MODEL = { provider: "anthropic", modelId: "claude-sonnet-5-5" } as const;

function instructions(nonce: string): string {
	const lines = [
		"This is an automated prompt-cache test. The repeated context below is intentional.",
		"Never call tools. Reply with exactly the text the user asks for.",
	];
	for (let index = 0; index < 250; index++) {
		lines.push(
			`${nonce} cache record ${String(index).padStart(3, "0")}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.`,
		);
	}
	return lines.join("\n");
}

const Parameters = Type.Object({ text: Type.String() });
const first = defineTool({
	name: "probe_first",
	description: "Unused probe tool.",
	parameters: Parameters,
	execute: async () => ({ output: [] }),
});
const second = defineTool({
	name: "probe_second",
	description: "Unused probe tool added on the second turn.",
	parameters: Parameters,
	execute: async () => ({ output: [] }),
});

/** 将开头的系统消息移到其前面的用户消息之后，复现修复前的请求顺序。 */
function committedOrder(messages: readonly Message[]): Message[] {
	if (messages[0]?.role !== "system") return [...messages];
	const [system, ...rest] = messages;
	const users = rest.findIndex((message) => message.role !== "user");
	const at = users === -1 ? rest.length : users;
	return [...rest.slice(0, at), system!, ...rest.slice(at)];
}

/** 添加工具后，第二轮请求从缓存读取的提示词占比。 */
async function cacheReadAfterToolChange(token: string, legacyOrder: boolean): Promise<number> {
	const base = builtinModels();
	const models = new Proxy(base, {
		get(target, property) {
			if (property === "streamSimple") {
				return (
					model: Parameters<Models["streamSimple"]>[0],
					request: Parameters<Models["streamSimple"]>[1],
					options?: Parameters<Models["streamSimple"]>[2],
				) =>
					streamSimpleAnthropic(model as Model<"anthropic-messages">, normalizeContext(request), {
						...options,
						apiKey: token,
					});
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Models;
	const registry = createRegistry();
	const probe = defineExtension({ name: "probe", tools: [first, second] });
	const legacy = defineExtension({
		name: "legacy-order",
		hooks: [hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: committedOrder(messages) }) })],
	});
	registry.install(probe);
	registry.install(legacy);
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { compaction: { enabled: false } } },
		context,
	);
	try {
		const root = await harness.root(context, {
			agent: {
				model: MODEL,
				thinkingLevel: "low",
				instructions: instructions(uuidv7()),
				extensions: legacyOrder ? [probe, legacy] : [probe],
				tools: [first],
			},
		});
		harness.resume();
		const ask = async (text: string): Promise<AssistantMessage> => {
			const settled = await (await root.submit({ type: "input", content: `Reply exactly: ${text}` }, context)).wait(
				context,
			);
			if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
			const record = await harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const message = record?.model?.[0] as AssistantMessage | undefined;
			expect(message?.stopReason, message?.errorMessage).toBe("stop");
			return message!;
		};
		const before = await ask("READY");
		expect(before.usage.input + before.usage.cacheRead + before.usage.cacheWrite).toBeGreaterThanOrEqual(4_000);
		await root.configure({ tools: [first, second] }, context);
		const after = (await ask("READY AGAIN")).usage;
		return after.cacheRead / (after.input + after.cacheRead + after.cacheWrite);
	} finally {
		await harness.close(context);
	}
}

describe("Durable system message order e2e", () => {
	// #10542 的实时回归测试；若 ~/.pi/agent/auth.json 中没有 Anthropic 凭据，则跳过。
	it.skipIf(!anthropicToken)(
		"keeps the prompt cache across a tool change only when the system message leads",
		{ retry: 1, timeout: 180_000 },
		async () => {
			// 修复前：输入消息位于系统消息之前，因此 Anthropic 会在请求开头发送工具列表，
			// 因此添加工具会从首个令牌开始改变缓存前缀。
			expect(await cacheReadAfterToolChange(anthropicToken!, true)).toBeLessThan(0.2);
			// 修复后：系统消息位于开头，初始工具列表保持固定，新工具则在对话中发送。
			expect(await cacheReadAfterToolChange(anthropicToken!, false)).toBeGreaterThan(0.8);
		},
	);
});
