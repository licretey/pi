import * as bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as bundledPiAiCompat from "@earendil-works/pi-ai/compat";
import * as bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
import * as bundledPiTui from "@earendil-works/pi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// 由于 index.ts 未重新导出 loader.ts 的导出项，因此此处导入是安全的。
// 扩展可以据此从 @earendil-works/pi-coding-agent 导入。
import * as bundledPiCodingAgent from "../../index.ts";

/** 源码和编译后二进制运行环境中可供扩展使用的模块。 */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@earendil-works/pi-agent-core": bundledPiAgentCore,
	"@earendil-works/pi-tui": bundledPiTui,
	// 扩展从 pi-ai 根路径导入时会解析到兼容入口（它严格包含核心入口的全部导出）：
	// 旧版扩展使用的全局 API 在兼容入口移除前仍可正常运行。
	"@earendil-works/pi-ai": bundledPiAiCompat,
	"@earendil-works/pi-ai/compat": bundledPiAiCompat,
	"@earendil-works/pi-ai/oauth": bundledPiAiOauth,
	"@earendil-works/pi-ai/providers/all": bundledPiAiProviders,
	"@earendil-works/pi-coding-agent": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};
