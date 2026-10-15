import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceEntry = new URL("../src/models.ts", import.meta.url).href;

// 在链接静态导入之前安装钩子，这样未使用的聚合导出也会受到检查。
const preload = `data:text/javascript,${encodeURIComponent(`
	import { registerHooks } from "node:module";
	const forbidden = [
		"/node_modules/typebox/",
		"/node_modules/@anthropic-ai/sdk/",
		"/node_modules/openai/",
		"/node_modules/@google/genai/",
		"/node_modules/@aws-sdk/",
		"/providers/data/",
		"/models.generated.",
	];
	registerHooks({
		load(url, context, nextLoad) {
			if (forbidden.some((part) => url.includes(part))) {
				throw new Error("Heavy dependency loaded by models entry: " + url);
			}
			return nextLoad(url, context);
		},
	});
`)}`;

describe("lightweight models entry", () => {
	it.each([sourceEntry, "@earendil-works/pi-ai/models"])(
		"runs a faux completion without TypeBox, catalogs, or SDKs through %s",
		(entry) => {
			const script = `
				import assert from "node:assert/strict";
				import { createModels, createProvider } from ${JSON.stringify(entry)};
				import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
				assert.equal(typeof createProvider, "function");
				const models = createModels();
				assert.deepEqual(models.getModels(), []);
				assert.deepEqual(models.getProviders(), []);
				const faux = fauxProvider();
				models.setProvider(faux.provider);
				faux.setResponses([fauxAssistantMessage("OK")]);
				const response = await models.completeSimple(faux.getModel(), { messages: [] });
				assert.equal(response.stopReason, "stop");
				assert.deepEqual(response.content, [{ type: "text", text: "OK" }]);
			`;
			const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "--eval", script], {
				cwd: packageRoot,
				encoding: "utf8",
				timeout: 10_000,
			});
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
		},
	);
});
