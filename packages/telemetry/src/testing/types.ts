import type { TelemetryContext } from "../index.ts";
import type { RecordedTelemetrySpan } from "../memory.ts";

/** 由单个一致性用例持有的全新适配器实例和规范化快照读取器。 */
export interface TelemetryAdapterFixture extends AsyncDisposable {
	readonly context: TelemetryContext;
	getSpans(): Promise<readonly RecordedTelemetrySpan[]>;
}

/** 为单个一致性用例创建隔离的适配器测试实例。 */
export type TelemetryAdapterFixtureFactory = () => Promise<TelemetryAdapterFixture>;

/** 与测试运行器无关的一致性用例，可注册到任意测试框架。 */
export interface TelemetryAdapterConformanceCase {
	readonly group: string;
	readonly name: string;
	run(): Promise<void>;
}
