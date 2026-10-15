/** 首次执行脚本时才加载 codemode 沙箱运行时（参见 execute.ts）。 */
export const loadCodemodeExecutor = () => import("./execute.ts");
