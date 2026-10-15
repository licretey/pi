/**
 * 使用官方 MCP 客户端一致性测试套件测试 pi（client.ts），并将每项检查与已提交的基线（baseline.json）比较。
 * 基线中原本通过的检查若不再通过，或出现基线未列出的失败项，脚本就会报错。已知失败仍会显示在
 * 输出中。详见 README.md。
 */

import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** 固定版本的上游测试套件。升级版本前必须审查并重新生成基线。 */
const CONFORMANCE_PACKAGE = "@modelcontextprotocol/conformance@0.2.0-alpha.11";
/** pi 会协商的协议版本。2026-07-28 属于 pi 不支持的另一种无状态协议。 */
const MODES = ["2025-03-26", "2025-06-18", "2025-11-25"] as const;
const SCENARIO_TIMEOUT_MS = 30_000;
/** 属于测试套件 HTTP 跟踪记录的检查项，不是断言。 */
const IGNORED_STATUSES = new Set(["INFO", "SKIPPED"]);

const here = fileURLToPath(new URL(".", import.meta.url));
const baselinePath = join(here, "baseline.json");
const clientPath = join(here, "client.ts");
const resolverUrl = pathToFileURL(join(here, "../../src/experimental/source-resolver.ts")).href;

type CheckStatus = "pass" | "fail";

interface ScenarioResult {
	mode: string;
	scenario: string;
	/** 检查 ID 到状态的映射。重复 ID 只有在每次检查都通过时才算通过。 */
	checks: Map<string, CheckStatus>;
	/** 按检查 ID 记录的失败消息，用于生成报告。 */
	messages: Map<string, string>;
}

interface BaselineScenario {
	passing: string[];
	failing: string[];
}

interface Baseline {
	conformance: string;
	modes: Record<string, Record<string, BaselineScenario>>;
}

interface RawCheck {
	id?: unknown;
	name?: unknown;
	status?: unknown;
	description?: unknown;
	errorMessage?: unknown;
}

function runCommand(
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						// 运行器会启动客户端和场景服务器，因此要结束整个进程组。
						if (child.pid !== undefined) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {}
						}
					}, options.timeoutMs);
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
		});
	});
}

function conformanceEnv(): NodeJS.ProcessEnv {
	// 测试套件通过 npm 获取且已包含构建产物，无需运行安装脚本。
	return { ...process.env, npm_config_ignore_scripts: "true", npm_config_yes: "true" };
}

async function listScenarios(mode: string, workDir: string): Promise<string[]> {
	const result = await runCommand("npx", ["--yes", CONFORMANCE_PACKAGE, "list", "--client", "--spec-version", mode], {
		cwd: workDir,
		env: conformanceEnv(),
	});
	if (result.code !== 0) throw new Error(`Listing ${mode} scenarios failed:\n${result.stderr || result.stdout}`);
	return [...result.stdout.matchAll(/^\s+- (\S+)/gm)].map((match) => match[1]);
}

function findFile(dir: string, name: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name === name) return path;
		if (entry.isDirectory()) {
			const found = findFile(path, name);
			if (found) return found;
		}
	}
	return undefined;
}

function record(result: ScenarioResult, id: string, status: CheckStatus, message?: string): void {
	if (result.checks.get(id) !== "fail") result.checks.set(id, status);
	if (status === "fail" && message && !result.messages.has(id)) result.messages.set(id, message);
}

async function runScenario(
	mode: string,
	scenario: string,
	launcher: string,
	workDir: string,
	verbose: boolean,
): Promise<ScenarioResult> {
	const scenarioDir = join(workDir, mode, scenario.replace(/[^A-Za-z0-9_.-]+/g, "-"));
	mkdirSync(scenarioDir, { recursive: true });
	const reportPath = join(scenarioDir, "pi-client.json");
	const result: ScenarioResult = { mode, scenario, checks: new Map(), messages: new Map() };
	const run = await runCommand(
		"npx",
		[
			"--yes",
			CONFORMANCE_PACKAGE,
			"client",
			"--command",
			launcher,
			"--scenario",
			scenario,
			"--spec-version",
			mode,
			"--timeout",
			String(SCENARIO_TIMEOUT_MS),
			"--output-dir",
			scenarioDir,
		],
		{
			cwd: workDir,
			env: { ...conformanceEnv(), PI_MCP_CONFORMANCE_REPORT: reportPath },
			timeoutMs: SCENARIO_TIMEOUT_MS + 30_000,
		},
	);
	if (verbose) process.stderr.write(run.stderr);

	const checksPath = findFile(scenarioDir, "checks.json");
	if (!checksPath) {
		record(result, "runner", "fail", `No checks.json (runner exit ${run.code}): ${run.stderr.trim().slice(-2000)}`);
		return result;
	}
	const checks = JSON.parse(readFileSync(checksPath, "utf8")) as RawCheck[];
	for (const check of checks) {
		const status = String(check.status ?? "FAILURE").toUpperCase();
		if (IGNORED_STATUSES.has(status)) continue;
		const id = String(check.id ?? check.name ?? "unnamed");
		const message = String(check.errorMessage ?? check.description ?? "");
		record(result, id, status === "SUCCESS" ? "pass" : "fail", message);
	}
	// pi 是否完成了场景。有些场景预期客户端会放弃，因此此项也像其他检查一样
	// 建立基线。
	let client: { success?: unknown; error?: unknown } = { error: "client.ts wrote no report" };
	if (existsSync(reportPath)) client = JSON.parse(readFileSync(reportPath, "utf8")) as typeof client;
	record(result, "pi-client", client.success === true ? "pass" : "fail", String(client.error ?? ""));
	return result;
}

function loadBaseline(): Baseline | undefined {
	if (!existsSync(baselinePath)) return undefined;
	return JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
}

function toBaseline(results: ScenarioResult[]): Baseline {
	const baseline: Baseline = { conformance: CONFORMANCE_PACKAGE, modes: {} };
	for (const result of results) {
		const ids = [...result.checks.keys()].sort();
		baseline.modes[result.mode] ??= {};
		baseline.modes[result.mode][result.scenario] = {
			passing: ids.filter((id) => result.checks.get(id) === "pass"),
			failing: ids.filter((id) => result.checks.get(id) === "fail"),
		};
	}
	return baseline;
}

/** 与基线比较，并返回是否存在回归。 */
function evaluate(results: ScenarioResult[], baseline: Baseline): boolean {
	const regressions: string[] = [];
	const fixed: string[] = [];
	for (const result of results) {
		const expected = baseline.modes[result.mode]?.[result.scenario];
		const label = `${result.mode} ${result.scenario}`;
		for (const [id, status] of result.checks) {
			const message = result.messages.get(id);
			if (status === "fail" && !expected?.failing.includes(id)) {
				regressions.push(`${label}: ${id} fails${message ? `: ${message}` : ""}`);
			}
			if (status === "pass" && expected?.failing.includes(id)) fixed.push(`${label}: ${id}`);
		}
		for (const id of expected?.passing ?? []) {
			if (!result.checks.has(id)) regressions.push(`${label}: ${id} was not reported`);
		}
	}
	for (const [mode, scenarios] of Object.entries(baseline.modes)) {
		for (const scenario of Object.keys(scenarios)) {
			if (!results.some((result) => result.mode === mode && result.scenario === scenario)) {
				regressions.push(`${mode} ${scenario}: scenario did not run`);
			}
		}
	}
	if (fixed.length > 0) {
		console.log(
			`\nFixed since the baseline (run with --update-baseline):\n${fixed.map((line) => `  ${line}`).join("\n")}`,
		);
	}
	if (regressions.length > 0) {
		console.log(`\nRegressions:\n${regressions.map((line) => `  ${line}`).join("\n")}`);
		return false;
	}
	console.log("\nNo regressions against the baseline.");
	return true;
}

function printResults(results: ScenarioResult[]): void {
	for (const mode of MODES) {
		const modeResults = results.filter((result) => result.mode === mode);
		if (modeResults.length === 0) continue;
		console.log(`\n${mode}`);
		for (const result of modeResults) {
			const statuses = [...result.checks.values()];
			const failed = statuses.filter((status) => status === "fail").length;
			const passed = statuses.length - failed;
			console.log(`  ${failed === 0 ? "pass" : "FAIL"} ${result.scenario} (${passed} passed, ${failed} failed)`);
			for (const [id, status] of result.checks) {
				if (status !== "fail") continue;
				const message = result.messages.get(id)?.replace(/\s+/g, " ").slice(0, 300);
				console.log(`         ${id}${message ? `: ${message}` : ""}`);
			}
		}
	}
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			mode: { type: "string", multiple: true },
			scenario: { type: "string", multiple: true },
			"update-baseline": { type: "boolean", default: false },
			"keep-results": { type: "boolean", default: false },
			verbose: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		console.log(`Usage: node packages/coding-agent/test/mcp-conformance/run.ts [options]

Options:
  --mode <version>     Only run this protocol version (repeatable): ${MODES.join(", ")}
  --scenario <name>    Only run this scenario (repeatable)
  --update-baseline    Write the results to baseline.json instead of comparing
  --keep-results       Keep the upstream checks.json and client output
  --verbose            Print the upstream runner output`);
		return 0;
	}
	if (process.platform === "win32") {
		console.error("The conformance runner needs a POSIX shell.");
		return 1;
	}
	const modes = values.mode ?? [...MODES];
	for (const mode of modes) {
		if (!(MODES as readonly string[]).includes(mode)) {
			console.error(`Unsupported mode ${mode}. Supported: ${MODES.join(", ")}`);
			return 1;
		}
	}
	const partial = values.mode !== undefined || values.scenario !== undefined;
	if (values["update-baseline"] && partial) {
		console.error("--update-baseline needs a full run, without --mode or --scenario.");
		return 1;
	}

	const workDir = mkdtempSync(join(tmpdir(), "pi-mcp-conformance-"));
	try {
		// 上游运行器会按空格拆分 --command，因此启动器路径中不能包含空格。
		const launcher = join(workDir, "pi-client");
		writeFileSync(
			launcher,
			`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(resolverUrl)} ${JSON.stringify(clientPath)} "$@"\n`,
		);
		chmodSync(launcher, 0o755);

		const results: ScenarioResult[] = [];
		for (const mode of modes) {
			const scenarios = (await listScenarios(mode, workDir)).filter(
				(scenario) => !values.scenario || values.scenario.includes(scenario),
			);
			for (const scenario of scenarios) {
				process.stderr.write(`${mode} ${scenario}\n`);
				results.push(await runScenario(mode, scenario, launcher, workDir, values.verbose));
			}
		}
		if (results.length === 0) {
			console.error("No scenarios matched.");
			return 1;
		}
		printResults(results);

		if (values["update-baseline"]) {
			writeFileSync(baselinePath, `${JSON.stringify(toBaseline(results), null, "\t")}\n`);
			console.log(`\nWrote ${baselinePath}`);
			return 0;
		}
		const baseline = loadBaseline();
		if (!baseline) {
			console.error("\nNo baseline.json. Run with --update-baseline and review it.");
			return 1;
		}
		if (baseline.conformance !== CONFORMANCE_PACKAGE) {
			console.error(`\nbaseline.json is for ${baseline.conformance}, not ${CONFORMANCE_PACKAGE}. Regenerate it.`);
			return 1;
		}
		const scoped: Baseline = partial
			? {
					conformance: baseline.conformance,
					modes: Object.fromEntries(
						modes.map((mode) => [
							mode,
							Object.fromEntries(
								Object.entries(baseline.modes[mode] ?? {}).filter(
									([scenario]) => !values.scenario || values.scenario.includes(scenario),
								),
							),
						]),
					),
				}
			: baseline;
		return evaluate(results, scoped) ? 0 : 1;
	} finally {
		if (values["keep-results"]) console.log(`\nResults kept in ${workDir}`);
		else rmSync(workDir, { recursive: true, force: true });
	}
}

process.exit(await main());
