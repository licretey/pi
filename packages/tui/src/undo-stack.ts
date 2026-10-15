/**
 * 通用撤销栈：压入时克隆状态。
 *
 * 保存状态快照的深克隆。弹出快照时直接返回，不再克隆，因为它已与原状态分离。
 */
export class UndoStack<S> {
	private stack: S[] = [];

	/** 将给定状态的深克隆压入栈中。 */
	push(state: S): void {
		this.stack.push(structuredClone(state));
	}

	/** 弹出并返回最近的快照；栈为空时返回 undefined。 */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** 清除所有快照。 */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
