import type {
	Context,
	JsonValue,
	ReplicatedStateSource,
	ReplicatedStateSourceAttachment,
	ReplicatedStateSourceFrame,
} from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import { errorMessage } from "../errors.ts";
import type { JsonObject, WatchEnd, WatchHandle } from "../types.ts";

export type ObservedDocumentValue = Readonly<JsonObject> | null;

/** 单个不可用的监视监听器后方最多保留的精确提交帧数。 */
const MAX_PENDING_WATCH_FRAMES = 100;

/** 文档实例退役时使用的标准终止更新。 */
export const RETIREMENT_OPERATIONS: readonly Op[] = [["r", null]];

/**
 * Session 到 Chord 的桥接对象，由一个已附加状态（文档或对话视图）一对一持有。值为 `null` 时，该对象会被退役。
 * @internal
 */
export class CommittedStateSource<T = ObservedDocumentValue> implements ReplicatedStateSource<T> {
	readonly #attachments = new Set<SessionSourceAttachment<T>>();
	#release: (() => void) | undefined;
	/** 释放对象时调用。 */
	#value: T | undefined;
	#cursor = 0;
	#retired = false;
	#closed = false;

	constructor(value: T, release: () => void) {
		this.#value = value;
		this.#release = release;
	}

	attach(): ReplicatedStateSourceAttachment<T> {
		if (this.#closed) throw new Error("State source is closed");
		const attachment = new SessionSourceAttachment({ value: this.#value as T, cursor: this.#cursor }, () => {
			this.#attachments.delete(attachment);
			if (this.#attachments.size === 0) this.#finishDisposal();
		});
		this.#attachments.add(attachment);
		return attachment;
	}

	advance(value: T, ops: readonly Op[], context: Context): void {
		if (this.#closed || this.#retired) return;
		this.#value = value;
		this.#cursor += 1;
		if (value === null) this.#retired = true;
		const frame: ReplicatedStateSourceFrame<T> = {
			cursor: this.#cursor,
			value,
			ops,
			context,
		};
		for (const attachment of [...this.#attachments]) attachment.publish(frame);
	}

	/** 停止发布；已附加的状态保留最后一个值。会话失败时也以相同方式结束。 */
	closeSession(): void {
		if (this.#closed) return;
		for (const attachment of [...this.#attachments]) attachment.dispose();
		this.#finishDisposal();
	}

	#finishDisposal(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#value = undefined;
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}
}

class SessionSourceAttachment<T> implements ReplicatedStateSourceAttachment<T> {
	readonly snapshot: { readonly value: T; readonly cursor: number };
	#release: (() => void) | undefined;
	readonly #frames: ReplicatedStateSourceFrame<T>[] = [];
	#listener: ((frame: ReplicatedStateSourceFrame<T>) => void) | undefined;
	#activated = false;
	#disposed = false;
	#scheduled = false;
	#delivering = false;

	constructor(snapshot: { readonly value: T; readonly cursor: number }, release: () => void) {
		this.snapshot = snapshot;
		this.#release = release;
	}

	activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void {
		if (this.#activated) throw new Error("State attachment is already active");
		if (this.#disposed) throw new Error("State attachment is disposed");
		this.#activated = true;
		this.#listener = listener;
		this.#drain();
	}

	publish(frame: ReplicatedStateSourceFrame<T>): void {
		if (this.#disposed) return;
		this.#frames.push(frame);
		if (!this.#activated || this.#delivering || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			if (this.#disposed) return;
			try {
				this.#drain();
			} catch {
				// Chord 的帧监听器会处理数据源契约错误。此处也隔离意外发生的直接监听器错误，仅影响当前附加对象。
				this.dispose();
			}
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#frames.length = 0;
		this.#listener = undefined;
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}

	#drain(): void {
		const listener = this.#listener;
		if (listener === undefined || this.#delivering || this.#disposed) return;
		this.#delivering = true;
		try {
			while (!this.#disposed) {
				const frame = this.#frames.shift();
				if (frame === undefined) break;
				listener(frame);
			}
		} finally {
			this.#delivering = false;
		}
	}
}

type WatchFrame<T> = {
	readonly value: T;
	readonly ops: readonly Op[];
	readonly context: Context;
};

/**
 * 绑定到单个文档实例或对话视图的串行精确帧监视器。值为 `null` 时，该监视器会被退役。
 * @internal
 */
export class CommittedWatch<T = ObservedDocumentValue> implements WatchHandle<T> {
	readonly #detach: () => void;
	readonly #report: (error: unknown) => void;
	readonly #replace: (() => T) | undefined;
	readonly #closed = Promise.withResolvers<WatchEnd>();
	readonly #pending: WatchFrame<T>[] = [];
	#value: T;
	#listener: ((value: T, ops: readonly Op[], context: Context) => Promise<void>) | undefined;
	#started = false;
	#scheduled = false;
	#running = false;
	#retired = false;
	/** 由 `#terminate()` 设置一次。 */
	#end: WatchEnd | undefined;
	#cancellationSignal: AbortSignal | undefined;
	#cancellationListener: (() => void) | undefined;

	/**
	 * `report` 接收监听器抛出的异常；发生异常也会结束监视。缓冲区溢出时，`replace` 用于生成要交付的值；
	 * 默认使用最新值。
	 */
	constructor(value: T, detach: () => void, report: (error: unknown) => void, replace?: () => T) {
		this.#value = value;
		this.#detach = detach;
		this.#report = report;
		this.#replace = replace;
	}

	get value(): T {
		return this.#value;
	}

	get closed(): Promise<WatchEnd> {
		return this.#closed.promise;
	}

	start(listener: (value: T, ops: readonly Op[], context: Context) => Promise<void>): void {
		if (this.#started) throw new Error("Watch is already started");
		if (this.#end !== undefined) throw new Error("Watch is stopped");
		this.#started = true;
		this.#listener = listener;
		if (this.#pending.length > 0) this.#schedule();
	}

	stop(): Promise<WatchEnd> {
		this.#terminate({ reason: "stopped" });
		return this.#closed.promise;
	}

	observeCancellation(signal: AbortSignal): void {
		if (this.#cancellationSignal !== undefined) throw new Error("Watch cancellation is already installed");
		if (this.#end !== undefined) return;
		this.#cancellationSignal = signal;
		this.#cancellationListener = () => this.cancel();
		signal.addEventListener("abort", this.#cancellationListener, { once: true });
		if (signal.aborted) this.cancel();
	}

	cancel(): void {
		this.#terminate({ reason: "cancelled" });
	}

	/** 会话正常结束时以 `session_closed` 结束；会话失败时以 `session_failed` 和错误信息结束。 */
	closeSession(failure?: { readonly error: unknown }): void {
		this.#terminate(
			failure === undefined ? { reason: "session_closed" } : { reason: "session_failed", error: failure.error },
		);
	}

	advance(value: T, ops: readonly Op[], context: Context): void {
		if (this.#end !== undefined || this.#retired) return;
		if (value === null) this.#retired = true;
		if (this.#pending.length >= MAX_PENDING_WATCH_FRAMES) {
			this.#pending.length = 0;
			const replacement = this.#replace?.() ?? value;
			this.#pending.push({ value: replacement, ops: [["r", replacement as JsonValue]], context });
		} else {
			this.#pending.push({ value, ops, context });
		}
		if (this.#started) this.#schedule();
	}

	#schedule(): void {
		if (this.#scheduled || this.#running || this.#end !== undefined) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			void this.#drain();
		});
	}

	async #drain(): Promise<void> {
		if (this.#running || this.#end !== undefined || !this.#started) return;
		this.#running = true;
		try {
			while (this.#end === undefined) {
				const frame = this.#pending.shift();
				if (frame === undefined) break;
				this.#value = frame.value;
				const deliveryContext = withoutAbortSignal(frame.context);
				try {
					await this.#listener!(frame.value, frame.ops, deliveryContext);
				} catch (error) {
					if (this.#end === undefined) {
						this.#report(error);
						this.#terminate({ reason: "listener_error", error: toError(error) });
					}
					break;
				}
				if (frame.value === null) {
					this.#terminate({ reason: "retired" });
					break;
				}
			}
		} finally {
			this.#running = false;
			if (this.#end === undefined && this.#pending.length > 0) this.#schedule();
		}
	}

	/** 仅结束一次监视：解除附加、丢弃待处理帧并完成 `closed`。已在运行的回调会继续执行。 */
	#terminate(end: WatchEnd): void {
		if (this.#end !== undefined) return;
		this.#end = end;
		this.#detach();
		this.#pending.length = 0;
		if (this.#cancellationListener !== undefined) {
			this.#cancellationSignal?.removeEventListener("abort", this.#cancellationListener);
		}
		this.#closed.resolve(end);
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(errorMessage(error));
}
