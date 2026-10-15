import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/index.ts";
import { type ModelRoute, type ModelRouteRequest, VIRTUAL_MODEL_STATE_ENTRY } from "../../src/core/virtual-models.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
};

type Route = (request: ModelRouteRequest, ctx: ExtensionContext) => ModelRoute;

/** 此测试使用的路由器：新用户轮次按思考级别选择模型，其余请求保持当前模型。 */
const defaultRoute: Route = (request, ctx) => {
	const find = (id: string) => ctx.modelRegistry.find("faux", id)!;
	if (request.reason === "direct") return { model: find("large"), thinkingLevel: "low" };
	const sticky = request.failed ?? request.previous;
	if (request.reason !== "user" && sticky) {
		return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "high" };
	}
	return request.thinkingLevel === "high"
		? { model: find("large"), thinkingLevel: "high" }
		: { model: find("small"), thinkingLevel: "off" };
};

describe("AgentSession virtual models", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createRoutedHarness(route: Route = defaultRoute, options: HarnessOptions = {}) {
		const requests: ModelRouteRequest[] = [];
		const harness = await createHarness({
			...options,
			models: [
				{ id: "small", contextWindow: 1000 },
				{ id: "large", contextWindow: 50_000, maxTokens: 4000, reasoning: true },
			],
			tools: [echoTool],
			extensionFactories: [
				...(options.extensionFactories ?? []),
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						thinkingLevels: ["low", "high"],
						contextWindow: 1000,
						route(request, ctx) {
							requests.push(request);
							return route(request, ctx);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		// 通过运行时建立流式调用；运行时会记录响应中的思考级别。
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await harness.session.setModel(runtime.getModel("router", "auto")!);
		harness.session.setThinkingLevel("high");
		const reasons = () => requests.map((request) => request.reason);
		/** 每条响应中记录的实际模型和思考级别。 */
		const dispatched = () =>
			harness.session.messages.flatMap((message) =>
				message.role === "assistant" ? [`${message.provider}/${message.model}:${message.thinkingLevel}`] : [],
			);
		return { harness, requests, reasons, dispatched };
	}

	it("routes each request, including retries, while the selection stays virtual", async () => {
		const { harness, requests, reasons, dispatched } = await createRoutedHarness(defaultRoute, {
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hello");

		expect(reasons()).toEqual(["user", "retry", "continuation"]);
		expect(requests[1].failed?.message.errorMessage).toBe("overloaded_error");
		expect(requests[2].previous?.model.id).toBe("large");
		expect(dispatched()).toEqual(["faux/large:high", "faux/large:high"]);
		expect(harness.session.model).toMatchObject({ provider: "router", id: "auto" });
		expect(harness.session.thinkingLevel).toBe("high");
		// 限制取自生成最近一次响应的实际模型，而非虚拟模型。
		expect(harness.session.getContextUsage()?.contextWindow).toBe(50_000);
	});

	it("retries the first request of a turn on the model routed for that turn", async () => {
		const { harness, requests, reasons, dispatched } = await createRoutedHarness(defaultRoute, {
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harness.session.setThinkingLevel("low");
		harness.setResponses([
			fauxAssistantMessage("easy answer"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("hard answer"),
		]);
		await harness.session.prompt("easy");
		harness.session.setThinkingLevel("high");

		await harness.session.prompt("hard");

		expect(reasons()).toEqual(["user", "user", "retry"]);
		// 重试信息应指向 large 上失败的请求，同时保留上一轮由 small 生成的响应。
		expect(requests[2].failed?.model.id).toBe("large");
		expect(requests[2].previous?.model.id).toBe("small");
		expect(dispatched()).toEqual(["faux/small:off", "faux/large:high"]);
	});

	it("routes the compact-and-retry after a truncated response as a retry", async () => {
		const { harness, requests, reasons } = await createRoutedHarness(defaultRoute, {
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
						compaction: { summary: "overflow compacted", firstKeptEntryId, tokensBefore },
					}));
				},
			],
		});
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["overflow"]);
		// 压缩可能会将提示词并入摘要，因此重试不属于新的用户轮次。
		expect(reasons()).toEqual(["user", "retry"]);
		expect(requests[1].failed?.model.id).toBe("large");
		expect(requests[1].failed?.message.stopReason).toBe("length");
	});

	it("routes requests after extension messages as continuations", async () => {
		const { harness, reasons } = await createRoutedHarness(defaultRoute, {
			extensionFactories: [
				(pi) => {
					let continued = false;
					pi.on("agent_before_settle", () => {
						if (continued) return undefined;
						continued = true;
						return {
							entries: [{ type: "custom_message", customType: "nudge", content: "Keep going.", display: false }],
							continue: true,
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");

		// 隐藏的自定义消息会作为用户消息发送给模型，但它并非用户编写。
		expect(reasons()).toEqual(["user", "continuation"]);
	});

	it("routes the first request of a prompt as a user turn when extension messages follow the prompt", async () => {
		const { harness, reasons } = await createRoutedHarness(defaultRoute, {
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "context", content: "Extra context.", display: false },
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");
		await harness.session.prompt("again");

		// 上下文以扩展消息结尾，但该请求仍是在回答用户的提示词。
		expect(harness.session.messages.at(-2)?.role).toBe("custom");
		expect(reasons()).toEqual(["user", "user"]);
	});

	it("ends the run with an error response when routing fails and keeps the last physical limits", async () => {
		let fail = false;
		const { harness } = await createRoutedHarness((request, ctx) => {
			if (fail) throw new Error("router unavailable");
			return defaultRoute(request, ctx);
		});
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("hello");

		fail = true;
		await harness.session.prompt("again");

		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			provider: "router",
			model: "auto",
			stopReason: "error",
			errorMessage: expect.stringContaining("router unavailable"),
		});
		expect(harness.faux.state.callCount).toBe(1);
		// 失败尝试记录的是虚拟模型，其声明的上下文窗口为 1k；实际应采用 large 模型的 50k 窗口。
		expect(harness.session.getContextUsage()?.contextWindow).toBe(50_000);
	});

	it("checks compaction against the physical model that produced the response", async () => {
		const { harness } = await createRoutedHarness();
		harness.setResponses([fauxAssistantMessage("short answer"), fauxAssistantMessage("long answer")]);
		await harness.session.prompt("hello");

		// 约 20k 个令牌超过虚拟模型声明的 1k 窗口，但仍在 large 模型的 50k 窗口内。
		await harness.session.prompt("x".repeat(80_000));

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("compacts before a request routed to a model with a smaller window", async () => {
		const { harness, dispatched } = await createRoutedHarness(defaultRoute, {
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
						compaction: { summary: "compacted", firstKeptEntryId, tokensBefore },
					}));
				},
			],
		});
		let compactedBeforeSmall = false;
		harness.setResponses([
			fauxAssistantMessage("y".repeat(8000)),
			() => {
				compactedBeforeSmall = harness.eventsOfType("compaction_end").length === 1;
				return fauxAssistantMessage("small answer");
			},
		]);
		await harness.session.prompt("hello");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);

		// 约 2k 个令牌符合上次响应所用 large 模型的限制，但超过 small 模型的 1k 窗口。
		harness.session.setThinkingLevel("low");
		await harness.session.prompt("next");

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(compactedBeforeSmall).toBe(true);
		expect(dispatched().at(-1)).toBe("faux/small:off");
	});

	it("compacts between turns of a run when the next request is routed to a smaller window", async () => {
		const route: Route = (request, ctx) =>
			request.reason === "continuation"
				? { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" }
				: defaultRoute(request, ctx);
		const { harness, dispatched } = await createRoutedHarness(route, {
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
						compaction: { summary: "compacted", firstKeptEntryId, tokensBefore },
					}));
				},
			],
		});
		let compactedBeforeSmall = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			() => {
				compactedBeforeSmall = harness.eventsOfType("compaction_end").length === 1;
				return fauxAssistantMessage("small answer");
			},
		]);

		// 约 2k 个令牌符合第一轮 large 模型的限制，但超过第二轮 small 模型的限制。
		await harness.session.prompt("x".repeat(8000));

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(compactedBeforeSmall).toBe(true);
		expect(dispatched()).toEqual(["faux/large:high", "faux/small:off"]);
	});

	it("projects the session once per request under a virtual selection", async () => {
		const { harness } = await createRoutedHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const projections = vi.spyOn(harness.sessionManager, "buildSessionProjection");

		await harness.session.prompt("hello");

		// 每个请求构建一次，轮次之间构建一次，运行结束后压缩检查再构建一次。
		expect(projections).toHaveBeenCalledTimes(4);
	});

	it("stores router state on the branch and passes it to later requests", async () => {
		const states: unknown[] = [];
		const { harness, reasons } = await createRoutedHarness(
			(request, ctx) => {
				states.push(request.state);
				const turns = (request.state as { turns: number } | undefined)?.turns ?? 0;
				const route = defaultRoute(request, ctx);
				// 返回 request.state 可沿用该状态而不重复存储。直接请求既不读取也不存储状态。
				if (request.reason === "continuation") return { ...route, state: request.state };
				return { ...route, state: { turns: turns + 1 } };
			},
			{ settings: { compaction: { keepRecentTokens: 1 } } },
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("summary"),
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const stored = () =>
			harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY ? [entry.data] : [],
				);
		expect(stored()).toEqual([
			{ provider: "router", modelId: "auto", state: { turns: 1 } },
			{ provider: "router", modelId: "auto", state: { turns: 2 } },
		]);

		await harness.session.compact();

		expect(reasons()).toEqual(["user", "continuation", "user", "direct"]);
		expect(states).toEqual([undefined, { turns: 1 }, { turns: 1 }, undefined]);
		expect(stored()).toHaveLength(2);
	});

	it("does not route compactions that an extension supplies", async () => {
		const route: Route = (request, ctx) => {
			if (request.reason === "direct") throw new Error("router unavailable");
			return defaultRoute(request, ctx);
		};
		const { harness, reasons } = await createRoutedHarness(route, {
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async ({ preparation: { firstKeptEntryId, tokensBefore } }) => ({
						compaction: { summary: "extension summary", firstKeptEntryId, tokensBefore },
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const result = await harness.session.compact();

		expect(result.summary).toBe("extension summary");
		expect(reasons()).toEqual(["user", "user"]);
	});

	it("routes compaction summaries before sizing them", async () => {
		const summaries: string[] = [];
		const { harness, reasons } = await createRoutedHarness(defaultRoute, {
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		const summary: FauxResponseStep = (_context, options, _state, model) => {
			summaries.push(`${model.id}:${options?.reasoning ?? "off"}:${options?.maxTokens}`);
			return fauxAssistantMessage("summary");
		};
		// 压缩使用同一个路由模型概括历史记录和拆分轮次的前缀。
		harness.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			summary,
			summary,
		]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary");
		expect(reasons()).toEqual(["user", "user", "direct"]);
		// 应用路由器指定的思考级别，且输出预算遵守 large 模型的 4000 令牌上限。
		expect(summaries).toEqual(["large:low:4000", "large:low:4000"]);
	});
});
