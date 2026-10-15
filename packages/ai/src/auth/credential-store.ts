import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "./types.ts";

/**
 * 默认的内存凭据存储。应用可注入持久化存储。
 * 以 `Provider.id` 为键，每个提供商对应一份凭据；详见 `CredentialStore`。
 * 通过 Promise 链按提供商串行处理写入。
 */
export class InMemoryCredentialStore implements CredentialStore {
	private credentials = new Map<string, Credential>();
	private chains = new Map<string, Promise<unknown>>();

	/** 按提供商 ID 串行执行任务；当前任务结束前不会解除该执行链。 */
	private enqueue<T>(providerId: string, task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const signal = operationSignal(options?.signal);
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			return task();
		})();
		const tail = queued.catch(() => {});
		this.chains.set(providerId, tail);
		void tail.then(() => {
			if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
		});
		return raceWithAbortSignal(queued, signal);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.credentials.get(providerId);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.enqueue(
			providerId,
			async () => {
				const current = this.credentials.get(providerId);
				const next = await fn(current);
				options?.signal?.throwIfAborted();
				if (next !== undefined) this.credentials.set(providerId, next);
				return next ?? current;
			},
			options,
		);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.enqueue(
			providerId,
			async () => {
				this.credentials.delete(providerId);
			},
			options,
		);
	}
}
