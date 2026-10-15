import type { StreamFn } from "./types.ts";

let defaultStreamFn: StreamFn | undefined;

/**
 * 配置调用方未传入 streamFn 时，Agent 与底层循环使用的后备。
 *
 * 自带默认模型运行时的宿主可以在这里安装它的流函数，
 * 而无需让 pi-agent-core 依赖某个提供商目录或兼容层。
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	defaultStreamFn = streamFn;
}

export function getDefaultStreamFn(): StreamFn {
	if (!defaultStreamFn) {
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	return defaultStreamFn;
}
