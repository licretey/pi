export interface ByteTransport {
	/** 发送一个字节块；多次调用必须按调用顺序传递。 */
	send(chunk: Uint8Array): Promise<void>;
	/** 关闭传输；重复调用不得产生副作用。 */
	close(): void;
}

export interface ByteTransportHandlers {
	/** 接收任意长度的入站字节块。 */
	onData(chunk: Uint8Array): void;
	/** 通知传输已正常关闭。 */
	onClose(): void;
	/** 通知发生了不可恢复的传输故障。 */
	onError(error: Error): void;
}

/** 创建新的已连接且已认证的传输；预期只会调用一种终止状态处理器。 */
export type ByteTransportFactory = (handlers: ByteTransportHandlers) => ByteTransport | Promise<ByteTransport>;
