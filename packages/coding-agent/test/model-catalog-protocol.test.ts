import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	getModelCatalogProviderKey,
	MODEL_CATALOG_INDEX_KEY,
	type ModelCatalogIndex,
	parseModelCatalogIndex,
	parseModelCatalogRequest,
	selectModelCatalog,
} from "../../../scripts/model-catalog-protocol.ts";
import { VERSION } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { allowNetwork } from "./test-network-env.ts";

// 使用 scripts/model-catalog-protocol.ts 中的共享协议，测试当前客户端是否采用 pi.dev 选择的模型目录。
// #9099 回归测试。

const legacyRevision = `sha256-${"a".repeat(64)}`;
const mixedApiRevision = `sha256-${"b".repeat(64)}`;
const modelId = "anthropic/claude-sonnet-5";
// 此时间晚于随包附带的目录，因此客户端会应用远程覆盖数据。
const lastModified = new Date("2099-01-01T00:00:00Z").toUTCString();
const commonModel = {
	id: modelId,
	name: "Claude Sonnet 5",
	provider: "openrouter",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};
const legacyModel = { ...commonModel, api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" };
const mixedApiModel = { ...commonModel, api: "anthropic-messages", baseUrl: "https://openrouter.ai/api" };

const index: ModelCatalogIndex = {
	schemaVersion: 1,
	defaultRevision: mixedApiRevision,
	catalogs: [
		{ minimumPiVersion: "0.80.7", revision: legacyRevision },
		{ minimumPiVersion: "0.85.0", revision: mixedApiRevision },
	],
};

// 旧版修订早于类型化分片，因此类型化请求会回退到仅包含聊天模型的分片。
const objects = new Map<string, unknown>([
	[MODEL_CATALOG_INDEX_KEY, index],
	[getModelCatalogProviderKey(legacyRevision, "openrouter", "legacy"), { [modelId]: legacyModel }],
	[getModelCatalogProviderKey(mixedApiRevision, "openrouter", "legacy"), { [modelId]: mixedApiModel }],
	[getModelCatalogProviderKey(mixedApiRevision, "openrouter", "typed"), [{ type: "chat", ...mixedApiModel }]],
]);

/** pi.dev 的 /api/models/providers/:provider 路由的最小模拟实现。 */
function startCatalogServer(requests: string[]): Promise<Server> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		requests.push(`${url.pathname}${url.search}`);
		const provider = /^\/api\/models\/providers\/([^/]+)$/.exec(url.pathname)?.[1];
		const catalogRequest = parseModelCatalogRequest(url, request.headers["user-agent"]);
		if (!provider) {
			response.writeHead(404).end();
		} else if (catalogRequest.kind === "redirect") {
			response.writeHead(307, { location: catalogRequest.location, "cache-control": "no-store" }).end();
		} else if (catalogRequest.kind === "invalid") {
			response.writeHead(400).end(catalogRequest.error);
		} else {
			const catalog = selectModelCatalog(
				parseModelCatalogIndex(objects.get(MODEL_CATALOG_INDEX_KEY)),
				catalogRequest.piVersion,
			);
			const body = catalog
				? (objects.get(getModelCatalogProviderKey(catalog.revision, provider, catalogRequest.representation)) ??
					objects.get(getModelCatalogProviderKey(catalog.revision, provider, "legacy")))
				: undefined;
			if (!catalog || body === undefined) {
				response.writeHead(404).end();
			} else {
				response
					.writeHead(200, {
						"content-type": "application/json",
						"last-modified": lastModified,
						"x-pi-model-catalog-revision": catalog.revision,
					})
					.end(JSON.stringify(body));
			}
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

describe("model catalog protocol with the current client", () => {
	const requests: string[] = [];
	let server: Server;
	let catalogBaseUrl: string;

	beforeAll(async () => {
		server = await startCatalogServer(requests);
		catalogBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	it("negotiates the catalog for its version and reaches the OpenRouter API", async () => {
		allowNetwork();
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			catalogBaseUrl,
			refreshOnCreate: false,
		});
		await runtime.setRuntimeApiKey("openrouter", "test-key");
		const refresh = await runtime.refresh({ allowNetwork: true, force: true, providers: ["openrouter"] });
		expect([...refresh.errors]).toEqual([]);

		const catalogUrl = "/api/models/providers/openrouter?types=chat%2Cimage%2Cclassifier";
		expect(requests).toEqual([catalogUrl, `${catalogUrl}&pi-version=${VERSION}`]);

		const expectedModel =
			selectModelCatalog(index, VERSION)?.revision === legacyRevision ? legacyModel : mixedApiModel;
		const model = runtime.getModel("openrouter", modelId);
		expect(model).toMatchObject({ api: expectedModel.api, baseUrl: expectedModel.baseUrl });
		if (!model) throw new Error(`Missing model: openrouter/${modelId}`);

		let providerUrl: URL | undefined;
		const nativeFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const request = new Request(input, init);
			if (new URL(request.url).origin !== "https://openrouter.ai") return nativeFetch(request);
			providerUrl = new URL(request.url);
			throw new Error("Provider request captured");
		});
		try {
			await runtime.completeSimple(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
				{ apiKey: "test-key", maxRetries: 0 },
			);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(providerUrl?.pathname).toBe(
			expectedModel.api === "anthropic-messages" ? "/api/v1/messages" : "/api/v1/chat/completions",
		);
	});
});
