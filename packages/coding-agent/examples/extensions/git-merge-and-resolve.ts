/**
 * 合并与冲突解决。
 *
 * 使当前工作分支与其上游跟踪引用保持同步。
 * 每轮智能体运行后都会获取并合并上游更改。没有冲突时会静默完成；
 * 出现冲突时会保留未清理的工作树，并向智能体发送后续消息，列出每个冲突块的
 * 文件、行范围以及 ours/theirs 内容，以便智能体解决冲突。
 * 此扩展也会重新发送上次未完成合并中的未解决冲突。
 *
 * 使用此扩展启动 pi：
 *   pi -e ./examples/extensions/git-merge-and-resolve.ts
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ConflictBlock {
	file: string;
	startLine: number;
	separatorLine: number;
	endLine: number;
}

/** 从包含未合并路径的工作树文件中解析冲突标记。 */
async function findConflicts(pi: ExtensionAPI, cwd: string): Promise<ConflictBlock[]> {
	const { stdout, code } = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"]);
	if (code !== 0 || !stdout.trim()) return [];

	const blocks: ConflictBlock[] = [];
	for (const file of stdout.trim().split("\n")) {
		try {
			const rl = createInterface({ input: createReadStream(join(cwd, file), "utf-8") });
			let lineNo = 0;
			let blockStart: number | undefined;
			let separatorLine: number | undefined;
			for await (const line of rl) {
				lineNo++;
				if (line.startsWith("<<<<<<<")) {
					blockStart = lineNo;
					separatorLine = undefined;
				} else if (line.startsWith("=======") && blockStart !== undefined) {
					separatorLine = lineNo;
				} else if (line.startsWith(">>>>>>>") && blockStart !== undefined && separatorLine !== undefined) {
					blocks.push({ file, startLine: blockStart, separatorLine, endLine: lineNo });
					blockStart = undefined;
					separatorLine = undefined;
				}
			}
		} catch {}
	}
	return blocks;
}

function formatRange(start: number, end: number): string {
	if (start > end) return "empty";
	if (start === end) return `${start}`;
	return `${start}-${end}`;
}

function formatConflicts(ref: string, blocks: ConflictBlock[]): string {
	const lines = [`Merged ${ref} with conflicts:`, ""];
	for (const b of blocks) {
		const ours = formatRange(b.startLine + 1, b.separatorLine - 1);
		const theirs = formatRange(b.separatorLine + 1, b.endLine - 1);
		lines.push(`  ${b.file}:${b.startLine}-${b.endLine} (ours ${ours}, theirs ${theirs})`);
	}
	lines.push("", "Resolve these conflicts.");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (_event, ctx) => {
		const { code: revParseCode } = await pi.exec("git", ["rev-parse", "--git-dir"]);
		if (revParseCode !== 0) return;

		let ref = "MERGE_HEAD";

		// 如果当前尚未处于合并过程中，则尝试执行合并。
		const { code: mergeHeadCode } = await pi.exec("git", ["rev-parse", "MERGE_HEAD"]);
		if (mergeHeadCode !== 0) {
			// 只有工作树干净时才尝试开始新的合并。
			const { stdout: status } = await pi.exec("git", ["status", "--porcelain"]);
			if (status.trim()) return;

			const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{u}",
			]);
			if (upstreamCode !== 0) return;

			ref = upstream.trim();
			const remote = ref.split("/")[0];
			ctx.ui.notify(`git-merge-and-resolve: fetching ${remote}, merging ${ref}`, "info");

			const { code: fetchCode, stderr: fetchErr } = await pi.exec("git", ["fetch", remote]);
			if (fetchCode !== 0) {
				ctx.ui.notify(`git-merge-and-resolve: fetch failed: ${fetchErr.trim()}`, "warning");
				return;
			}

			const { code: mergeCode } = await pi.exec("git", ["merge", "--no-ff", ref]);
			if (mergeCode === 0) return;
		}

		// 此处可能是刚刚发生合并冲突，也可能是已有未完成的合并。
		const conflicts = await findConflicts(pi, ctx.cwd);
		if (conflicts.length === 0) return;

		pi.sendUserMessage(formatConflicts(ref, conflicts), { deliverAs: "followUp" });
	});
}
