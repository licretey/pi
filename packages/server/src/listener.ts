import type { ByteConnectionAcceptor } from "./connection.ts";

/** 在完成所需的传输身份验证后，提供已建立的字节流连接。 */
export interface ServerListener {
	/** 开始监听，并将通过授权的连接交给 accept 处理。 */
	start(accept: ByteConnectionAcceptor): Promise<void>;
	close(): Promise<void>;
}
