import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../config.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";

export type BlockedStatus = { kind: NonNullable<ProgramStatus["kind"]>; message: string };

function firstLine(text: string | undefined): string {
	return text?.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

/**
 * 将交互模式状态通过 OSC 7501 报告给终端：代理运行或压缩期间为 `working`，对话框等待用户操作时为 `blocked`，
 * 运行结束后则为 `done`、`error` 或 `idle`。报告内容仅包括会话名称、对话框标题和错误首行；
 * 不会报告提示词或助手输出。
 */
export class ProgramStatusReporter {
	private readonly getTerminal: () => Terminal;
	private readonly getSessionName: () => string | undefined;
	private runActive = false;
	private compacting = false;
	/** 当前运行结束后报告的结果。 */
	private runResult: ProgramStatus = { state: "done" };
	/** 当前没有运行任务时的状态。 */
	private restingStatus: ProgramStatus = { state: "idle" };
	/** 按打开顺序记录各来源的对话框；报告最近打开的对话框。 */
	private readonly blocked = new Map<string, BlockedStatus>();
	private lastReport: string | undefined;

	constructor(getTerminal: () => Terminal, getSessionName: () => string | undefined) {
		this.getTerminal = getTerminal;
		this.getSessionName = getSessionName;
	}

	handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.runActive = true;
				this.runResult = { state: "done" };
				break;
			case "message_end":
				// 最后一次响应决定运行结果，因此重试成功后会以成功结果取代之前的错误。
				if (event.message.role !== "assistant") return;
				this.runResult =
					event.message.stopReason === "error"
						? { state: "error", message: firstLine(event.message.errorMessage) }
						: { state: "done" };
				break;
			case "compaction_start":
				this.compacting = true;
				break;
			case "compaction_end":
				this.compacting = false;
				if (this.runActive) {
					// 恢复期间的上下文压缩失败会结束本次运行，除非后续响应成功。
					if (event.aborted) this.runResult = { state: "idle" };
					else if (event.errorMessage) this.runResult = { state: "error", message: firstLine(event.errorMessage) };
				} else if (event.aborted) {
					this.restingStatus = { state: "idle" };
				} else if (event.reason === "manual") {
					this.restingStatus = event.errorMessage
						? { state: "error", message: firstLine(event.errorMessage) }
						: { state: "done" };
				}
				break;
			case "agent_settled":
				this.runActive = false;
				this.restingStatus = event.aborted ? { state: "idle" } : this.runResult;
				break;
			case "session_info_changed":
				// 会话名称会显示在进行中和已完成的报告中。
				break;
			default:
				return;
		}
		this.report();
	}

	/** 对话框关闭前持续报告 `blocked`；传入 `undefined` 可清除状态。同一来源重新打开时会替换原状态。 */
	setBlocked(source: string, status: BlockedStatus | undefined): void {
		this.blocked.delete(source);
		if (status) this.blocked.set(source, status);
		this.report();
	}

	/** 清除上一个会话的运行状态，例如切换会话后调用。 */
	reset(): void {
		this.runActive = false;
		this.compacting = false;
		this.runResult = { state: "done" };
		this.restingStatus = { state: "idle" };
		this.report();
	}

	report(): void {
		const status: ProgramStatus = { ...this.currentStatus(), app: APP_NAME };
		const key = JSON.stringify(status);
		if (key === this.lastReport) return;
		this.lastReport = key;
		this.getTerminal().setProgramStatus(status);
	}

	private currentStatus(): ProgramStatus {
		const blocked = [...this.blocked.values()].at(-1);
		if (blocked) return { state: "blocked", ...blocked };
		if (this.compacting) return { state: "working", message: "Compacting context" };
		const status = this.runActive ? { state: "working" as const } : this.restingStatus;
		if (status.state === "working" || status.state === "done") return { ...status, message: this.getSessionName() };
		return status;
	}
}
