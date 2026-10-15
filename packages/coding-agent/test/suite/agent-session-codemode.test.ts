import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantImages,
	type ClassifierModel,
	type ClassifierResult,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type ImageModel,
	type ImagesContext,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import { createToolDefinitionFromAgentTool } from "../../src/core/tools/tool-definition-wrapper.ts";
import { readCodemodeStore } from "../../src/extensions/codemode/execute.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import {
	CODEMODE_DOCS_PATH,
	CODEMODE_STORE_ENTRY_TYPE,
	type CodemodeToolDetails,
	createCodemodeTool,
} from "../../src/extensions/codemode/tool.ts";
import { createHarness, getToolResult, type Harness, type HarnessOptions } from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const echoSchema = Type.Object({ text: Type.String({ description: "Text to echo" }) });
const echoTool: AgentTool<typeof echoSchema> = {
	name: "echo",
	label: "Echo",
	description: "Echo text back.\n\nSecond paragraph.",
	parameters: echoSchema,
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `echo: ${params.text}` }],
		details: {},
	}),
};

const statsTool: AgentTool = {
	name: "stats",
	label: "Stats",
	description: "Return structured stats",
	parameters: Type.Object({}),
	outputSchema: Type.Object({ files: Type.Number(), names: Type.Array(Type.String()) }),
	execute: async () => ({
		content: [{ type: "text", text: "2 files" }],
		details: {},
		structuredContent: { files: 2, names: ["a", "b"] },
	}),
};

const screenshotTool: AgentTool = {
	name: "screenshot",
	label: "Screenshot",
	description: "Return a screenshot",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [
			{ type: "text", text: "captured" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
		],
		details: {},
	}),
};

function usage(input: number, cost: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

const codemodeResult = (harness: Harness) => getToolResult(harness, "codemode");

/** 脚本头部之后的输出；提取时会检查并移除该头部。 */
function resultText(message: ToolResultMessage): string {
	const [header, ...items] = message.content;
	expect(header).toEqual({
		type: "text",
		text: expect.stringMatching(/^Script (completed|failed)\nWall time \d+\.\d seconds\nOutput:\n$/),
	});
	return items.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
}

const TINY_PNG_LABEL = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/;

/**
 * 检查每个文件是否包含指定的小型 PNG，然后将 `text` 中的 `[Image saved to ...]` 标签
 * 替换为 `<saved>`，并删除这些文件。
 */
function checkSavedImages(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const path = TINY_PNG_LABEL.exec(line)?.[1];
			if (!path) return line;
			try {
				expect(readFileSync(path).toString("base64")).toBe(TINY_PNG_BASE64);
			} finally {
				rmSync(path, { force: true });
			}
			return "<saved>";
		})
		.join("\n");
}

describe("AgentSession codemode tool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(extensionFactories?: HarnessOptions["extensionFactories"]) {
		// 由扩展注册，因此它们会与内置 codemode 一起，在会话的工具上下文中运行。
		const registerTools = (pi: ExtensionAPI) => {
			for (const tool of [echoTool as AgentTool, statsTool, screenshotTool]) {
				pi.registerTool(createToolDefinitionFromAgentTool(tool));
			}
		};
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension(), registerTools, ...(extensionFactories ?? [])],
		});
		harnesses.push(harness);
		return harness;
	}

	it("presents callable tools per codemode.mode", async () => {
		const harness = await setup();
		const description = (name: string) =>
			harness.session.agent.state.tools.find((tool) => tool.name === name)?.description ?? "";
		const requestTools: string[][] = [];
		const requestPrompts: string[] = [];
		const record = (context: TranscriptContext) => {
			requestTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
			requestPrompts.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage("ok");
		};

		// on：工具声明会说明脚本如何调用这些工具，因此 codemode 中不再重复列出。
		harness.session.setActiveToolsByName(["read", "echo", "codemode"]);
		expect(description("echo")).toContain("Codemode: `tools.echo(args)` resolves to");
		expect(description("echo")).not.toContain("codemode tool declaration:");
		expect(description("codemode")).not.toContain("### `echo`");
		harness.setResponses([record]);
		await harness.session.prompt("on");
		expect(requestTools[0]).toEqual(expect.arrayContaining(["read", "echo", "codemode"]));
		expect(requestPrompts[0]).toContain("\n- read: ");

		// only：codemode 会列出 echo；echo 仍处于启用状态，但不会放入请求。
		harness.settingsManager.applyOverrides({ codemode: { mode: "only" } });
		harness.session.setActiveToolsByName(["read", "echo", "codemode"]);
		expect(description("echo")).not.toContain("Codemode: `tools.echo");
		expect(description("codemode")).toContain("### `echo`");
		expect(description("codemode")).not.toContain("### `stats`");
		harness.setResponses([record]);
		await harness.session.prompt("only");
		expect(requestTools[1]).toContain("codemode");
		expect(requestTools[1]).not.toContain("echo");
		expect(requestTools[1]).not.toContain("read");
		// 提示词中的工具列表与声明一致：隐藏工具不会列出（#10192）。
		expect(requestPrompts[1]).not.toContain("\n- read: ");
		expect(requestPrompts[1]).toContain("\n- codemode: ");
		expect(harness.session.systemPrompt).not.toContain("\n- read: ");
		// 隐藏工具的使用指南会从规则区移至各自的 codemode 区域（#10343）。
		expect(requestPrompts[1]).not.toContain("Use read to examine files");
		expect(description("codemode")).toContain("- Use read to examine files instead of cat or sed.");

		// 未启用 codemode 时，工具保留普通描述。
		harness.session.setActiveToolsByName(["echo"]);
		expect(description("echo")).toBe("Echo text back.\n\nSecond paragraph.");
	});

	// #10343
	it("shows the guidelines of tools that do not fit the inline budget through describeTool()", async () => {
		const harness = await setup();
		harness.settingsManager.applyOverrides({ codemode: { mode: "only", inlineBudget: 0 } });
		harness.session.setActiveToolsByName(["read", "codemode"]);
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(codemode?.description).not.toContain("### `read`");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(await describeTool("read"))' })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(resultText(codemodeResult(harness))).toContain("- Use read to examine files instead of cat or sed.");
	});

	it("runs nested calls in parallel and returns only the script result", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const [a, b, stats] = await Promise.all([
								tools.echo({ text: "one" }),
								tools.echo({ text: "two" }),
								tools.stats({}),
							]);
							console.log("files", stats.files);
							text(ALL_TOOLS.map((tool) => tool.name).join(","));
							return { a, b, names: stats.names };
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		expect(result.isError).toBe(false);
		expect(resultText(result)).toBe(
			'==> text 1/2 <==\necho,stats,screenshot\n==> text 2/2 <==\n{"a":"echo: one","b":"echo: two","names":["a","b"]}\n<console_output>\nfiles 2\n</console_output>',
		);
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.status])).toEqual([
			["echo", "ok"],
			["echo", "ok"],
			["stats", "ok"],
		]);
		expect(details.calls.every((call) => call.id.startsWith(`${result.toolCallId}/`))).toBe(true);
		// 嵌套调用不会成为对话记录中的工具结果；其事件会携带父调用 ID。
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
	});

	it("routes nested calls through extension hooks", async () => {
		const harness = await setup([
			(pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "echo" && (event.input as { text: string }).text === "forbidden") {
						return { block: true, reason: "echo of forbidden text is blocked" };
					}
					return undefined;
				});
				pi.on("tool_result", (event) => {
					if (event.toolName === "stats") {
						return { content: [{ type: "text", text: "redacted" }] };
					}
					return undefined;
				});
			},
		]);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							let blocked;
							try {
								await tools.echo({ text: "forbidden" });
							} catch (error) {
								blocked = error.message;
							}
							const stats = await tools.stats({});
							return { blocked, stats };
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		// 替换 content 却不替换 structured content 会丢失结构化结果。
		expect(JSON.parse(resultText(result))).toEqual({
			blocked: "echo of forbidden text is blocked",
			stats: "redacted",
		});
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => call.status)).toEqual(["error", "ok"]);
	});

	it("adds the usage of nested results to the codemode result", async () => {
		const billedTool: AgentTool = {
			name: "billed",
			label: "Billed",
			description: "Run a model",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ran" }], details: {}, usage: usage(100, 0.25) }),
		};
		const harness = await setup([(pi) => pi.registerTool(createToolDefinitionFromAgentTool(billedTool))]);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `await tools.billed({}); await tools.billed({}); await tools.echo({ text: "x" });`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		expect(result.usage).toMatchObject({ input: 200, totalTokens: 200, cost: { total: 0.5 } });
		// 用量会随结果一同持久化，因此会计入会话总量。
		const persisted = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(
			persisted?.type === "message" && persisted.message.role === "toolResult" && persisted.message.usage,
		).toEqual(result.usage);
		expect(harness.session.getSessionStats().cost).toBe(0.5);
	});

	it("keeps structured content that tool_result handlers replace along with the content", async () => {
		const harness = await setup([
			(pi) => {
				pi.on("tool_result", (event) =>
					event.toolName === "stats"
						? { content: [{ type: "text", text: "0 files" }], structuredContent: { files: 0, names: [] } }
						: undefined,
				);
				// 后续处理器若只修改 details，会保留首个处理器设置的内容。
				pi.on("tool_result", (event) => (event.toolName === "stats" ? { details: { audited: true } } : undefined));
			},
		]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.stats({});" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(JSON.parse(resultText(codemodeResult(harness)))).toEqual({ files: 0, names: [] });
	});

	// Saved images: https://github.com/earendil-works/pi/issues/10310
	it("attaches only the images the script passes to image(), in output order, each after its saved path", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							// 未声明 outputSchema 的工具会解析为文本结果；图片不会传递给后续调用。
							const shot = await tools.screenshot({});
							text(shot);
							image("data:image/png;base64,${TINY_PNG_BASE64}");
							image("data:image/png;base64,${TINY_PNG_BASE64}");
							text("after");
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		// 同一图像即使显示两次也只保存一次，因此两个标签指向同一个文件。
		const lines = resultText(result).split("\n");
		expect(lines).toEqual([
			"==> text 1/2 <==",
			"captured",
			lines[2],
			"<image>",
			lines[2],
			"<image>",
			"==> text 2/2 <==",
			"after",
		]);
		expect(checkSavedImages(lines[2])).toBe("<saved>");
		expect(result.content[2]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
	});

	it("marks where each text item starts and puts console lines last in one text block", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: 'text("one\\ntwo");\nconsole.log("a");\nconsole.log("b");\ntext("three\\n");\nreturn 4;',
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		// 提供方会直接拼接相邻文本块，或在中间插入换行，因此最终输出是一个文本块。
		const result = codemodeResult(harness);
		expect(result.content).toHaveLength(2);
		expect(resultText(result)).toBe(
			"==> text 1/3 <==\none\ntwo\n==> text 2/3 <==\nthree\n==> text 3/3 <==\n4\n<console_output>\na\nb\n</console_output>",
		);
	});

	it("reports script failures as results that keep partial output and the calls that ran", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `text("partial");\nconsole.log("log");\nawait tools.echo({ text: "x" });\nthrow new Error("boom");`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = codemodeResult(harness);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/^Script failed\n/);
		const text = resultText(result);
		expect(text).toMatch(/^partial\n<console_output>\nlog\n<\/console_output>\nScript error:\nError: boom\n/);
		expect(text).toContain("codemode.js:4");
		expect(text).toContain("Tool calls made before the failure (they are not undone): echo (ok)");
		expect((result.details as unknown as CodemodeToolDetails).calls.map((call) => call.name)).toEqual(["echo"]);
	});
});

describe("codemode options and store", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// 未覆盖工具：会话会自行构建 codemode 工具，其中包括存储写入器。
	async function setup() {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension()],
		});
		harnesses.push(harness);
		return harness;
	}

	async function run(harness: Harness, code: string): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return codemodeResult(harness);
	}

	function storeEntries(harness: Harness): unknown[] {
		return harness.sessionManager
			.getBranch()
			.filter(
				(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === CODEMODE_STORE_ENTRY_TYPE,
			)
			.map((entry) => entry.data);
	}

	const increment = `const next = (load("count") ?? 0) + 1;\nstore("count", next);\nreturn next;`;

	it("applies the timeout_ms option and rejects invalid options", async () => {
		const harness = await setup();
		const timedOut = await run(harness, '// @options: {"timeout_ms": 200}\nwhile (true) {}');
		expect(timedOut.isError).toBe(true);
		expect(resultText(timedOut)).toContain("Script error:\nScript timed out");

		const invalid = await run(harness, '// @options: {"yield": 1}\ntext(1)');
		expect(invalid.isError).toBe(true);
		expect(invalid.content).toEqual([
			{
				type: "text",
				text: "@options only supports `max_output_tokens` and `timeout_ms`; got `yield`",
			},
		]);
	});

	it("limits script memory so runaway allocations fail inside the script", async () => {
		const harness = await setup();
		const result = await run(
			harness,
			'// @options: {"timeout_ms": 30000}\nlet a = [];\ntry { while (true) a.push("x".repeat(1 << 20) + a.length); } catch (error) { const n = a.length; a = null; return { n, error: String(error) }; }',
		);
		expect(result.isError).toBe(false);
		const { n, error } = JSON.parse(resultText(result)) as { n: number; error: string };
		expect(error).toContain("out of memory");
		// 每个条目至少占用 1 MiB，因此达到限制时脚本远未触及 wasm32 的 4 GiB 上限。
		expect(n).toBeLessThan(512);
	});

	it("truncates output to the token budget and spills the full text", async () => {
		const harness = await setup();
		const result = await run(
			harness,
			`// @options: {"max_output_tokens": 30}\nfor (let i = 0; i < 100; i++) text("row " + i);\nimage("data:image/png;base64,${TINY_PNG_BASE64}");`,
		);
		const details = result.details as unknown as CodemodeToolDetails;
		const path = details.fullOutputPath;
		if (!path) throw new Error("No spill file");
		try {
			const text = resultText(result);
			expect(text).toMatch(/^Warning: truncated output/);
			expect(text).toContain("row 0\n");
			expect(text).toContain("tokens truncated");
			expect(text).toContain("row 99\n");
			expect(text).not.toContain("row 50\n");
			expect(text).toContain(`[Full output: ${path} (read with offset/limit)]`);
			// 图像位于截断文本之后，每张图像都紧跟其保存路径。
			expect(result.content.at(-1)).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
			expect(checkSavedImages(text.split("\n").at(-2) ?? "")).toBe("<saved>");
			expect(readFileSync(path, "utf8")).toBe(
				Array.from({ length: 100 }, (_, i) => `==> text ${i + 1}/100 <==\nrow ${i}`).join("\n"),
			);
		} finally {
			rmSync(path, { force: true });
		}

		const small = await run(harness, "return { ok: true };");
		expect((small.details as unknown as CodemodeToolDetails).fullOutputPath).toBeUndefined();
	});

	it("resolves bash calls to structured results, also for non-zero exit codes", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode", "bash"],
			extensionFactories: [createCodemodeExtension()],
		});
		harnesses.push(harness);
		const result = await run(
			harness,
			'const r = await tools.bash({ command: "echo out; exit 3" });\ntext(JSON.stringify([r.output, r.exit_code, typeof r.wall_time_seconds]));',
		);
		expect(result.isError).toBe(false);
		expect(resultText(result)).toBe('["out\\n",3,"number"]');
	});

	// https://github.com/earendil-works/pi/issues/10251
	it("resolves read calls to text for text files and to image blocks that image() shows", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode", "read"],
			extensionFactories: [createCodemodeExtension()],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "notes.txt"), "hello");
		writeFileSync(join(harness.tempDir, "pixel.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
		const result = await run(
			harness,
			'text(await tools.read({ path: "notes.txt" }));\nconst shot = await tools.read({ path: "pixel.png" });\ntext(shot.note);\nimage(shot);',
		);
		expect(result.isError).toBe(false);
		expect(checkSavedImages(resultText(result))).toBe(
			"==> text 1/2 <==\nhello\n==> text 2/2 <==\nRead image file [image/png]\n<saved>\n<image>",
		);
		expect(result.content.at(-1)).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
	});

	it("persists store() writes as custom entries for later calls", async () => {
		const harness = await setup();
		expect(resultText(await run(harness, increment))).toBe("1");
		expect(resultText(await run(harness, increment))).toBe("2");
		expect(storeEntries(harness)).toEqual([
			{ set: { count: 1 }, delete: [] },
			{ set: { count: 2 }, delete: [] },
		]);
		const appended = harness
			.eventsOfType("entry_appended")
			.filter((event) => event.entry.type === "custom" && event.entry.customType === CODEMODE_STORE_ENTRY_TYPE);
		expect(appended).toHaveLength(2);

		expect(resultText(await run(harness, 'store("count", undefined);\nreturn load("count") === undefined;'))).toBe(
			"true",
		);
		expect(storeEntries(harness).at(-1)).toEqual({ set: {}, delete: ["count"] });
	});

	it("appends nothing for failed scripts or scripts without writes", async () => {
		const harness = await setup();
		expect((await run(harness, 'store("count", 5);\nthrow new Error("boom");')).isError).toBe(true);
		expect((await run(harness, 'return load("count") ?? "missing";')).isError).toBe(false);
		expect(storeEntries(harness)).toEqual([]);
	});

	it("runs without a session, starting from an empty store", async () => {
		const tool = createCodemodeTool();
		const result = await tool.execute("direct", { code: increment });
		expect(result.content[1]).toEqual({ type: "text", text: "1" });
	});

	it("loads the values written on the current branch", async () => {
		const harness = await setup();
		await run(harness, increment);
		const firstPrompt = harness.sessionManager.getBranch().find((entry) => entry.type === "message");
		if (!firstPrompt) throw new Error("No first prompt entry");
		expect(resultText(await run(harness, increment))).toBe("2");

		// 从第一条提示词处创建分支：之后写入的存储条目位于另一条路径上。
		harness.sessionManager.branch(firstPrompt.id);
		expect(resultText(await run(harness, increment))).toBe("1");
	});

	it("folds store entries from the root, ignoring malformed data", () => {
		const entry = (data: unknown, customType = CODEMODE_STORE_ENTRY_TYPE): CustomEntry => ({
			type: "custom",
			customType,
			data,
			id: Math.random().toString(36).slice(2),
			parentId: null,
			timestamp: new Date(0).toISOString(),
		});
		expect(
			readCodemodeStore([
				entry({ set: { a: 1, b: { c: 2 } }, delete: [] }),
				entry({ set: { a: 3 }, delete: ["b"] }),
				entry({ set: { z: 1 } }),
				entry({ set: { other: 1 }, delete: [] }, "other-extension"),
			]),
		).toEqual({ a: 3 });
	});
});

describe("codemode models", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const scorerModel: ClassifierModel<"test-classifier"> = {
		type: "classifier",
		id: "judge",
		name: "Judge",
		api: "test-classifier",
		provider: "scorer",
		baseUrl: "https://classifier.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		headers: { "X-Secret": "hunter2" },
	};

	const painterModel: ImageModel<"test-images"> = {
		type: "image",
		id: "painter",
		name: "Painter",
		api: "test-images",
		provider: "scorer",
		baseUrl: "https://images.test/v1",
		input: ["text", "image"],
		output: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	interface ClassifyObservation {
		baseUrl: string;
		apiKey: string | undefined;
		text: unknown;
	}

	interface ImagesObservation {
		baseUrl: string;
		apiKey: string | undefined;
		input: ImagesContext["input"];
	}

	async function setup() {
		const harness = await createHarness({
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension()],
		});
		harnesses.push(harness);
		const observed: ClassifyObservation[] = [];
		const imageRequests: ImagesObservation[] = [];
		let active = 0;
		let maxActive = 0;
		harness.session.modelRuntime.registerProvider("scorer", {
			apiKey: "secret-key",
			models: [scorerModel, painterModel],
			images: {
				"test-images": {
					generateImages: async (model, context, options): Promise<AssistantImages> => {
						imageRequests.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey, input: context.input });
						const prompt = context.input.find((block) => block.type === "text")?.text;
						const base = { api: model.api, provider: model.provider, model: model.id, timestamp: 0 };
						if (prompt === "explode") {
							return { ...base, output: [], stopReason: "error", errorMessage: "painter exploded" };
						}
						return {
							...base,
							output: [
								{ type: "text", text: `painted ${prompt}` },
								{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
							],
							usage: usage(100, 0.04),
							stopReason: "stop",
						};
					},
				},
			},
			classifiers: {
				"test-classifier": {
					classify: async (model, context, options): Promise<ClassifierResult> => {
						active++;
						maxActive = Math.max(maxActive, active);
						await new Promise((resolve) => setTimeout(resolve, 10));
						active--;
						const text = context.state.text;
						observed.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey, text });
						if (text === "explode") {
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								answers: {},
								stopReason: "error",
								errorMessage: "classifier exploded",
								timestamp: 0,
							};
						}
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							answers: { approved: { type: "bool", probability: text === "good" ? 0.9 : 0.1 } },
							usage: usage(300, 0.001),
							stopReason: "stop",
							timestamp: 0,
						};
					},
				},
			},
		});
		harness.session.setActiveToolsByName(["codemode"]);
		return { harness, observed, imageRequests, maxActive: () => maxActive };
	}

	async function run(harness: Harness, code: string): Promise<ToolResultMessage> {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		return codemodeResult(harness);
	}

	const questions = `{ approved: { type: "bool", instructions: "Approval?", criteria: { true: "yes", false: "no" } } }`;

	it("declares models only for the session's own codemode tool", async () => {
		const { harness } = await setup();
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		// 描述会列出 models 全局对象，并指向 API 文档。
		expect(codemode?.description).toContain("`models`: classifiers and image generation");
		expect(codemode?.description).toContain(CODEMODE_DOCS_PATH);

		const overridden = await createHarness({ tools: [createCodemodeTool() as AgentTool] });
		harnesses.push(overridden);
		const plain = overridden.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(plain?.description).not.toContain("`models`");
	});

	it("lists models and classifies with catalog auth, ignoring script-supplied fields", async () => {
		const { harness, observed, maxActive } = await setup();
		const result = await run(
			harness,
			`
			const [model] = await models.getAvailableOfType("classifier", "scorer");
			const listed = await models.getModelsOfType("classifier");
			const same = await models.getModelOfType("classifier", "scorer", "judge");
			const texts = ["good", "bad", "good", "bad", "good", "bad"];
			const results = await Promise.all(
				texts.map((text) => models.classify({ ...model, baseUrl: "https://evil.test" }, { state: { text }, questions: ${questions} })),
			);
			return {
				id: model.id,
				headers: "headers" in model,
				listed: listed.some((entry) => entry.provider === "scorer" && entry.id === "judge"),
				same: same.id,
				missing: (await models.getModelOfType("classifier", "scorer", "nope")) === undefined,
				probabilities: results.map((r) => r.answers.approved.probability),
				cost: results[0].usage.cost.total,
			};
		`,
		);
		expect(result.isError).toBe(false);
		expect(JSON.parse(resultText(result))).toEqual({
			id: "judge",
			headers: false,
			listed: true,
			same: "judge",
			missing: true,
			probabilities: [0.9, 0.1, 0.9, 0.1, 0.9, 0.1],
			cost: 0.001,
		});
		expect(observed).toHaveLength(6);
		expect(
			observed.every((entry) => entry.baseUrl === "https://classifier.test/v1" && entry.apiKey === "secret-key"),
		).toBe(true);
		// 共进行六次分类，同时最多有四次分类在执行。
		expect(maxActive()).toBe(4);
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.args, call.status, call.cost])).toEqual(
			Array.from({ length: 6 }, () => ["models.classify", "scorer/judge", "ok", 0.001]),
		);
		// 分类结果的用量会成为 codemode 结果的用量。
		expect(result.usage?.input).toBe(1800);
		expect(result.usage?.cost.total).toBeCloseTo(0.006, 10);
		expect(harness.session.getSessionStats().cost).toBeCloseTo(0.006, 10);
	});

	it("generates images with catalog auth and attaches them through image()", async () => {
		const { harness, imageRequests } = await setup();
		const result = await run(
			harness,
			`
			const [model] = await models.getAvailableOfType("image", "scorer");
			const reference = { type: "image", data: "${TINY_PNG_BASE64}", mimeType: "image/png" };
			const generated = await models.generateImages(
				{ ...model, baseUrl: "https://evil.test" },
				{ input: [{ type: "text", text: "a fox" }, reference] },
			);
			for (const block of generated.output) {
				if (block.type === "image") image(block);
				else text(block.text);
			}
			const failed = await models.generateImages(model, { input: [{ type: "text", text: "explode" }] });
			const attempt = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
			return {
				id: model.id,
				stopReason: generated.stopReason,
				failed: [failed.stopReason, failed.errorMessage],
				wrongType: await attempt(() => models.generateImages({ provider: "scorer", id: "judge" }, { input: [] })),
			};
		`,
		);
		expect(result.isError).toBe(false);
		const [header, text, ...rest] = checkSavedImages(resultText(result)).split("\n");
		expect(header).toBe("==> text 1/2 <==");
		expect(text).toBe("painted a fox");
		expect(rest[0]).toBe("<saved>");
		expect(rest[1]).toBe("<image>");
		expect(rest[2]).toBe("==> text 2/2 <==");
		expect(JSON.parse(rest.slice(3).join("\n"))).toEqual({
			id: "painter",
			stopReason: "stop",
			failed: ["error", "painter exploded"],
			wrongType:
				'"scorer/judge" is a classifier model, not an image model. List the image models you can use with models.getAvailableOfType("image").',
		});
		expect(result.content[2]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
		expect(imageRequests.map((request) => [request.baseUrl, request.apiKey])).toEqual([
			["https://images.test/v1", "secret-key"],
			["https://images.test/v1", "secret-key"],
		]);
		expect(imageRequests[0].input).toEqual([
			{ type: "text", text: "a fox" },
			{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
		]);
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.args, call.status, call.cost, call.error])).toEqual([
			["models.generateImages", "scorer/painter", "ok", 0.04, undefined],
			["models.generateImages", "scorer/painter", "error", undefined, "painter exploded"],
		]);
		expect(result.usage?.cost.total).toBeCloseTo(0.04, 10);
		expect(harness.session.getSessionStats().cost).toBeCloseTo(0.04, 10);
	});

	it("notes generated images that the script did not show", async () => {
		const { harness } = await setup();
		const result = await run(
			harness,
			`
			const [model] = await models.getAvailableOfType("image", "scorer");
			const generated = await models.generateImages(model, { input: [{ type: "text", text: "a fox" }] });
			return generated.stopReason;
		`,
		);
		expect(result.isError).toBe(false);
		expect(resultText(result)).toBe(
			"stop\nNote: models.generateImages() returned 1 image that the script did not show. Show each image block of result.output with image(block).",
		);
	});

	it("reports provider errors as results and invalid arguments as exceptions", async () => {
		const { harness } = await setup();
		const result = await run(
			harness,
			`
			const model = await models.getModelOfType("classifier", "scorer", "judge");
			const failed = await models.classify(model, { state: { text: "explode" }, questions: ${questions} });
			const textOnly = await models.classify(model, {
				state: { text: "good" },
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
				questions: ${questions},
			});
			const attempt = async (fn) => { try { await fn(); return "ok"; } catch (error) { return error.message; } };
			return {
				failed: [failed.stopReason, failed.errorMessage],
				textOnly: [textOnly.stopReason, textOnly.errorMessage],
				badClassifierImage: await attempt(() =>
					models.classify(model, { state: {}, images: [{ data: "aW1hZ2U=" }], questions: ${questions} }),
				),
				badType: await attempt(() => models.getModelsOfType("video")),
				unknown: await attempt(() => models.classify({ provider: "scorer", id: "nope" }, {})),
				noModel: await attempt(() => models.classify("judge", {})),
				undefinedModel: await attempt(() => models.classify(undefined, {})),
				noState: await attempt(() => models.classify(model, { questions: ${questions} })),
				badQuestion: await attempt(() =>
					models.classify(model, { state: {}, questions: { kind: { type: "choice", instructions: "Kind?", criteria: ["a", "b"] } } }),
				),
				badImage: await attempt(() => models.generateImages({ provider: "scorer", id: "painter" }, { prompt: "a fox" })),
				badSplit: await attempt(() => models.getModelOfType("classifier", "scorer/judge")),
			};
		`,
		);
		expect(result.isError).toBe(false);
		const value = JSON.parse(resultText(result));
		expect(value.failed).toEqual(["error", "classifier exploded"]);
		expect(value.textOnly).toEqual(["error", "Model scorer/judge does not accept image input"]);
		expect(value.badClassifierImage).toContain(
			"models.classify() context.images[0] must be an image block, got { data }.",
		);
		expect(value.badType).toContain('Unknown model type "video"');
		expect(value.unknown).toBe(
			'Unknown classifier model "scorer/nope". List the classifier models you can use with models.getAvailableOfType("classifier").',
		);
		expect(value.noModel).toContain(
			"models.classify() expects a classifier model as its first argument, got a string.",
		);
		expect(value.undefinedModel).toContain(
			"models.getModelOfType() returns undefined for an unknown provider or id.",
		);
		expect(value.noState).toContain("models.classify() context.state must be an object, got undefined.");
		expect(value.noState).toContain("codemode.md");
		expect(value.badQuestion).toContain(
			'context.questions.kind is a "choice" question, so criteria must map each label to its meaning.',
		);
		expect(value.badImage).toContain(
			"models.generateImages() context.input must be a non-empty array of blocks, got undefined.",
		);
		expect(value.badSplit).toContain("The provider and the id are separate arguments");
		const details = result.details as unknown as CodemodeToolDetails;
		expect(details.calls.map((call) => [call.name, call.status, call.error])).toEqual([
			["models.classify", "error", "classifier exploded"],
			["models.classify", "error", "Model scorer/judge does not accept image input"],
		]);
		expect(result.usage).toBeUndefined();
	});
});
