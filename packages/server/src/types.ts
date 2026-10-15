import type { Context, JsonValue, ServiceCall, ServiceProviderUpdate } from "@earendil-works/chord";
import type { ServerListener } from "./listener.ts";

export interface ServerOptions {
	listeners: readonly ServerListener[];
	/** 由安装或配置档案提供的稳定逻辑服务器标识。 */
	serverId: string;
	maxFrameLength?: number;
	handshakeTimeoutMs?: number;
	onConnectionCountChanged?: (count: number) => void;
	onError?: (error: Error) => void;
}

export type MaybePromise<T> = T | Promise<T>;

/** 服务器路由所需的最小持久化 Session 元数据。应用程序可以扩展此类型。 */
export interface SessionMetadata {
	readonly id: string;
}

/** 一个表示层连接对托管 Session 所拥有的实时能力。 */
export interface RoutedSessionAttachment {
	/** 将一个与契约无关的服务操作路由到已附加的 Session 端点。 */
	invokeService(
		call: ServiceCall,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
		context: Context,
	): Promise<JsonValue | undefined>;
	release(context: Context): MaybePromise<void>;
}

/** 服务器服务实现可用的表示层路由能力。 */
export interface RoutedServerPresentation {
	attachSession(sessionId: string, context: Context): Promise<void>;
	detachSession(context: Context): Promise<void>;
	/** 应用程序删除持久化元数据前，释放已路由的附加关系和句柄。 */
	prepareSessionRemoval(sessionId: string, context: Context): Promise<void>;
}

/** 单个连接对应的服务器级服务端点。 */
export interface RoutedServerServiceAttachment {
	invokeService(
		call: ServiceCall,
		publish: (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => MaybePromise<void>,
		context: Context,
	): Promise<JsonValue | undefined>;
	release(context: Context): MaybePromise<void>;
}

export interface RoutedServerServiceHost {
	attachClient(presentation: RoutedServerPresentation, context: Context): MaybePromise<RoutedServerServiceAttachment>;
}

/** 可安全跨进程传递的句柄，用于获取限定在当前展示范围内的 Session 能力。 */
export interface RoutedSessionHandle {
	attachClient(context: Context): MaybePromise<RoutedSessionAttachment>;
	/** 意外终止时以错误拒绝；按预期关闭后则解析为 undefined。 */
	readonly terminated?: Promise<Error | undefined>;
	close(context: Context): Promise<void>;
}

/** 服务器全局管理和 Session 路由所需的应用程序能力。 */
export interface ServerHost<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly serverServices: RoutedServerServiceHost;
	/** 解析一个持久化 Session ID；无法解析时抛出可控的路由错误。 */
	resolveSession(sessionId: string, context: Context): Promise<TMetadata>;
	openSession(metadata: TMetadata, context: Context): Promise<RoutedSessionHandle>;
}
