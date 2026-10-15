import type { ServerOptions } from "../../types.ts";

export interface UnixListenerOptions {
	path: string;
	/** 套接字文件权限。默认仅允许所有者读写（0o600）。 */
	mode?: number;
	/** 每个连接允许排队的最大分帧字节数；超过后会断开响应缓慢的对端。 */
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	/** 用于推导和校验 maxPendingBytes；自定义时必须与服务器设置一致。 */
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}

export interface UnixServerOptions extends Omit<ServerOptions, "listeners">, UnixListenerOptions {}
