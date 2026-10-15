import { getKeybindings } from "../keybindings.ts";
import { Loader } from "./loader.ts";

/**
 * 可通过 Escape 键取消的加载指示器。
 * 扩展 Loader，并提供用于取消异步操作的 AbortSignal。
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	private abortController = new AbortController();

	/** 用户按下 Escape 键时调用。 */
	onAbort?: () => void;

	/** 用户按下 Escape 键时会中止的 AbortSignal。 */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/** 加载指示器是否已中止。 */
	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.abortController.abort();
			this.onAbort?.();
		}
	}

	dispose(): void {
		this.stop();
	}
}
