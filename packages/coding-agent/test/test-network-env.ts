import { vi } from "vitest";

/** 为使用本地夹具或模拟对象替代外部 I/O 的测试启用网络代码路径。 */
export function allowNetwork(): void {
	vi.stubEnv("PI_OFFLINE", undefined);
}
