import type { ExecutionEnv } from "../env/index.ts";
import type { ToolExecutionApi } from "../harness/types.ts";

/** 本次调用的执行环境；没有环境的工具以普通错误结果失败。 */
export function requireEnv(api: ToolExecutionApi): ExecutionEnv {
	if (api.env === undefined) throw new Error("No execution environment is configured");
	return api.env;
}
