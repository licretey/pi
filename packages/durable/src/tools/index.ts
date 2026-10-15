import { defineExtension } from "../harness/define.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createReadTool, type ReadToolOptions } from "./read.ts";
import { createWriteTool } from "./write.ts";

export {
	type BashExecution,
	type BashPrepare,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createPowerShellTool,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./bash.ts";
export { createEditTool, type EditToolDetails, type EditToolInput } from "./edit.ts";
export {
	DEFAULT_IMAGE_LIMITS,
	type ImageLimits,
	type ImageProcessor,
	type PreparedImage,
} from "./image-processor.ts";
export { createReadTool, type ReadToolDetails, type ReadToolInput, type ReadToolOptions } from "./read.ts";
export { createWriteTool, type WriteToolInput } from "./write.ts";

/**
 * `coding-tools` 扩展：`read`、`write`、`edit` 和 `bash`；没有任何机制自动安装它。
 * `createPowerShellTool()` 额外提供 `powershell`。`images` 负责准备 `read` 返回的图像（见 `ReadToolOptions`）。
 */
export function createCodingTools(options: ReadToolOptions = {}) {
	return defineExtension({
		name: "coding-tools",
		tools: [createReadTool(options), createWriteTool(), createEditTool(), createBashTool()],
	});
}

/** 不带图像处理器的 `createCodingTools()`。 */
export const CodingTools = createCodingTools();
