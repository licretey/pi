import type { ServiceSubscriptionSnapshot } from "@earendil-works/chord";
import type { RpcTarget, SessionTarget } from "@earendil-works/pi-protocol";
import type { ByteTransportFactory } from "./transport.ts";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface ConnectionStateChange {
	state: ConnectionState;
	error?: Error;
}

export type Unsubscribe = () => void;
export type ListenerErrorHandler = (error: Error) => void;
export type AttachmentChangeListener = (attachment: SessionTarget | undefined) => void;

export interface ServiceSubscription {
	readonly id: string;
	readonly target: RpcTarget;
	readonly snapshot: ServiceSubscriptionSnapshot;
	/** 调用方应用快照后，开始按顺序接收更新。 */
	start(): void;
	dispose(): Promise<void>;
}

export interface ClientOptions {
	transportFactory: ByteTransportFactory;
	/** 该物理端点应对应的逻辑服务器身份。 */
	serverId: string;
	maxFrameLength?: number;
	/** 报告订阅者故障，同时避免故障破坏客户端状态。 */
	onListenerError?: ListenerErrorHandler;
}
