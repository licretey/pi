/**
 * 用于 Emacs 风格剪切和粘贴操作的环形缓冲区。
 *
 * 跟踪剪切（删除）的文本条目。连续剪切可以合并为一个条目。
 * 支持 yank（粘贴最近条目）和 yank-pop（循环浏览较早条目）。
 */
export class KillRing {
	private ring: string[] = [];

	/**
	 * 将文本加入剪切环。
	 *
	 * @param text 要加入的剪切文本。
	 * @param opts 压入选项。
	 * @param opts.prepend 累积时，前置（向后删除）还是追加（向前删除）文本。
	 * @param opts.accumulate 是否与最近的条目合并，而不是创建新条目。
	 */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (opts.accumulate && this.ring.length > 0) {
			const last = this.ring.pop()!;
			this.ring.push(opts.prepend ? text + last : last + text);
		} else {
			this.ring.push(text);
		}
	}

	/** 获取最近的条目，但不修改剪切环。 */
	peek(): string | undefined {
		return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
	}

	/** 将最后一个条目移到最前面（供 yank-pop 循环使用）。 */
	rotate(): void {
		if (this.ring.length > 1) {
			const last = this.ring.pop()!;
			this.ring.unshift(last);
		}
	}

	get length(): number {
		return this.ring.length;
	}
}
