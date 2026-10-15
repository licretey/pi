import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * 通过变量形式的模块说明符加载 Bedrock 实现，避免打包器
 *（如浏览器冒烟测试和 Bun 编译）沿导入路径加载仅适用于 Node.js 的
 * AWS SDK。`.ts`/`.js` 后缀转换可确保源码和构建后的
 * 输出都能使用此方式。
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let bedrockModuleOverride: ProviderStreams | undefined;

/**
 * 覆盖动态导入的 Bedrock 实现。Bun
 * 二进制构建无法打包变量形式的导入，因此会改为由构建过程
 * 注册静态导入的模块。
 */
export function setBedrockProviderModule(module: ProviderStreams): void {
	bedrockModuleOverride = module;
}

export const bedrockConverseStreamApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			bedrockModuleOverride ?? ((await importNodeOnlyApi("./bedrock-converse-stream.ts")) as ProviderStreams),
	);
