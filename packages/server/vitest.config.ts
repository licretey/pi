import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * 为裸模块说明符配置精确匹配，并为每个软件包的子路径导出单独配置规则，例如
 * `@earendil-works/pi-ai/utils/uuid`。使用前缀别名会将其错误地改写为 `index.ts/utils/uuid`。
 */
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: src("../agent/src/index.ts") },
			{ find: /^@earendil-works\/pi-agent-core\/(.+)$/, replacement: `${src("../agent/src/")}$1.ts` },
			{ find: /^@earendil-works\/pi-ai$/, replacement: src("../ai/src/index.ts") },
			{ find: /^@earendil-works\/pi-ai\/(.+)$/, replacement: `${src("../ai/src/")}$1.ts` },
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: src("../telemetry/src/index.ts") },
			{ find: /^@earendil-works\/pi-protocol$/, replacement: src("../protocol/src/index.ts") },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
