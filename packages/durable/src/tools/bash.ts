import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "typebox";
import { defineTool } from "../harness/define.ts";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "../harness/types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../truncate.ts";
import { requireEnv } from "./env.ts";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

const powershellSchema = Type.Object({
	command: Type.String({ description: "PowerShell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

/** 调用 `bash` 或 `powershell` 的程序会收到什么。 */
const shellStructuredOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr: the retained tail, as the model sees it" }),
	truncated: Type.Boolean({ description: "Whether earlier output was dropped" }),
	fullOutputPath: Type.Optional(Type.String({ description: "File with the complete output, when it was spilled" })),
	exitCode: Type.Number(),
});

export type BashToolInput = Static<typeof bashSchema>;
export type PowerShellToolInput = Static<typeof powershellSchema>;
export type ShellStructuredOutput = Static<typeof shellStructuredOutputSchema>;

/** 即将运行的一条命令，`prepare` 可以修改它：脚本、工作目录和环境。 */
export interface BashExecution {
	command: string;
	cwd: string;
	env: Record<string, string>;
	inheritEnv: boolean;
}

export type BashPrepare = (execution: BashExecution, api: ToolExecutionApi, context: Context) => void | Promise<void>;

export interface BashToolOptions {
	commandPrefix?: string;
	prepare?: BashPrepare;
}

export interface PowerShellToolOptions {
	/** 每条命令之前先运行的若干行。 */
	commandPrefix?: string;
	prepare?: BashPrepare;
	/** 依次尝试的 PowerShell 程序；默认先 `pwsh` 再 `powershell`。无法启动的程序会被跳过。 */
	programs?: readonly string[];
}

function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
}

/** 一次调用的执行过程：带前缀的命令、环境的工作目录，然后交给 `prepare`。 */
async function prepareExecution(
	command: string,
	options: { commandPrefix?: string; prepare?: BashPrepare } | undefined,
	api: ToolExecutionApi,
	context: Context,
): Promise<BashExecution> {
	const execution: BashExecution = {
		command: options?.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
		cwd: requireEnv(api).cwd,
		env: {},
		inheritEnv: true,
	};
	await options?.prepare?.(execution, api, context);
	return execution;
}

/**
 * 依次运行每种命令形态，直到某一个能启动；把输出流入保留窗口内的 `api.output()`，并把结果转换为工具结果：
 * 溢出（spill）诊断、非零退出的错误结果，以及超时等失败时抛出的错误。结构化输出在保留输出之外附上退出码。
 */
async function runCommand(
	commands: readonly (string | readonly string[])[],
	execution: BashExecution,
	timeout: number | undefined,
	api: ToolExecutionApi,
	context: Context,
): Promise<ToolExecutionResult> {
	const env = requireEnv(api);
	let result: Awaited<ReturnType<typeof env.exec>> | undefined;
	for (const command of commands) {
		result = await env.exec(
			command,
			{
				cwd: execution.cwd,
				env: execution.env,
				inheritEnv: execution.inheritEnv,
				...(timeout === undefined ? {} : { timeout }),
				onOutput: (text, _context, info) => api.output(text, info.skipped),
				spill: { afterBytes: DEFAULT_MAX_BYTES, afterLines: DEFAULT_MAX_LINES },
				// 环境随后可以省略保留尾窗之外的输出，并上报省略量。
				...(api.outputWindow === undefined ? {} : { window: api.outputWindow }),
			},
			context,
		);
		// 无法启动的程序不会产生任何输出；下一种形态可以。
		if (result.ok || result.error.code !== "spawn_error") break;
	}
	if (result === undefined) throw new Error("No command to run");
	const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
	if (spillPath !== undefined) {
		api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${spillPath}` });
	}
	if (!result.ok) {
		if (result.error.code === "aborted" && context.abortSignal?.aborted) throw result.error;
		if (result.error.code === "timeout") throw new Error(`Command timed out after ${timeout} seconds`);
		if (result.error.code === "aborted") throw new Error("Command aborted");
		throw result.error;
	}
	const exitCode = result.value.exitCode;
	const retained = api.retainedOutput();
	const structuredOutput: ShellStructuredOutput = {
		output: retained.text,
		truncated: retained.truncated,
		...(spillPath === undefined ? {} : { fullOutputPath: spillPath }),
		exitCode,
	};
	if (exitCode === 0) return { structuredOutput };
	const exited = { severity: "error", code: "exit_code", message: `Command exited with code ${exitCode}` } as const;
	return { structuredOutput, isError: true, diagnostics: [exited] };
}

/**
 * 通过环境的 shell 运行命令。输出流入 `api.output()`，由执行架（Harness）在默认限度内保留尾窗；结果内容即
 * 该保留输出。保留窗口会传给环境，环境可以省略窗口之外的输出并报告省略了多少，使被丢弃的计数保持精确。
 * 超出限度的输出溢出到文件，其路径作为诊断上报。非零退出是带退出码的错误结果；超时则抛出错误，产生的
 * 错误结果仍携带输出与诊断。
 */
export function createBashTool(options?: BashToolOptions): ToolRegistration<typeof bashSchema> {
	return defineTool({
		name: "bash",
		description: `Execute a bash command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		structuredOutputSchema: shellStructuredOutputSchema,
		outputLimits: { retain: "tail" },
		async execute(args, api, context) {
			validateTimeout(args.timeout);
			const execution = await prepareExecution(args.command, options, api, context);
			return runCommand([execution.command], execution, args.timeout, api, context);
		},
	});
}

/** 无论控制台代码页是什么，都以 UTF-8 输出——与 coding agent 的 `powershell` 工具一致。 */
const UTF8_OUTPUT = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}";
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/**
 * 运行 PowerShell 命令，与 `bash` 类似，但用的是 PowerShell 而非环境的 shell：优先 `pwsh`（PowerShell 7），
 * 否则 Windows PowerShell。程序以命令作为参数直接启动，因此没有别的 shell 参与解析。
 */
export function createPowerShellTool(options?: PowerShellToolOptions): ToolRegistration<typeof powershellSchema> {
	const programs = options?.programs ?? ["pwsh", "powershell"];
	return defineTool({
		name: "powershell",
		description: `Execute a PowerShell command in the current working directory. Returns combined stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: powershellSchema,
		structuredOutputSchema: shellStructuredOutputSchema,
		outputLimits: { retain: "tail" },
		async execute(args, api, context) {
			validateTimeout(args.timeout);
			const execution = await prepareExecution(args.command, options, api, context);
			const script = `${UTF8_OUTPUT}\n${execution.command}`;
			const commands = programs.map((program) => [program, ...POWERSHELL_ARGS, script]);
			return runCommand(commands, execution, args.timeout, api, context);
		},
	});
}
