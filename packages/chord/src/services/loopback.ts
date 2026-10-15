import type { RemoteServiceTransport } from "../types.ts";
import type { RemoteServiceProvider } from "./provider.ts";

/** 将提供程序连接到绑定，同时保持远程服务语义不变。 */
export function createLoopbackServiceTransport(provider: RemoteServiceProvider): RemoteServiceTransport {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = provider.subscribe(serviceId, mode, listener);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}
