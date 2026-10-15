import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
// Bun 会将 .wasm 导入项作为文件加载：在编译后的可执行文件中会嵌入该文件，并解析为可读取的路径。
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setEmbeddedQuickJSWasmPath } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
setEmbeddedQuickJSWasmPath(quickjsWasmPath);
