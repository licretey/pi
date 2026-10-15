import type { ConversationId } from "./types.ts";

/**
 * 取出被抛出值的 message，而自身不抛错：对 `Object.create(null)` 这类值，`String()` 本身会抛异常，
 * 格式化错误的代码绝不能因为被格式化的值而失败。
 */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return String(error);
	} catch {
		return Object.prototype.toString.call(error);
	}
}

/** 事务在第一次表写入之后又去读取了表。请先读取所有需要的行，再进行写入。 */
export class ReadAfterWrite extends Error {
	constructor(method: string) {
		super(`Tx.${method}() cannot read tables after the first table write`);
		this.name = "ReadAfterWrite";
	}
}

/**
 * 存储读取拒绝了无效请求，例如未知的对话或来自另一次扫描的游标，不会产生任何持久效果。与存储抛出的其他错误不同，
 * 它只会让那次读取失败，而不会终结会话；但在 `commit()` 中抛出时，与其他错误一样是致命的。
 */
export class StorageRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageRequestError";
	}
}

/**
 * 会话已失败，此后不再运行或提交任何内容。会话失败于：Storage 方法抛错、提交无法被采纳，或 Harness 自身簿记抛错
 * （调度器提交、内部提交监听器、`snapshot()` 抛错的注册表）。`cause` 是那第一个错误。请重新打开会话；
 * 重新打开可从已提交的内容中恢复。
 */
export class SessionFailed extends Error {
	constructor(cause: unknown) {
		super("Session failed after a storage error; close and reopen it", { cause });
		this.name = "SessionFailed";
	}
}

/** 提交请求送达了忙碌的对话，因此未被受理。 */
export class ConversationBusy extends Error {
	readonly conversationId: ConversationId;

	constructor(conversationId: ConversationId) {
		super(`Conversation ${conversationId} is busy`);
		this.name = "ConversationBusy";
		this.conversationId = conversationId;
	}
}
