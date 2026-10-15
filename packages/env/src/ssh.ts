import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, type ConnectionOptions } from "./connection.ts";

/** 本软件包提供守护进程的远程系统。 */
export type RemotePlatform = {
	platform: "linux" | "android" | "darwin" | "windows";
	arch: "x64" | "arm64";
	/** 远程主目录，采用远程系统自身使用的路径格式。 */
	home: string;
	/** Windows 上 `sshd` 用于执行命令的 shell（`DefaultShell`）。 */
	shell?: "cmd" | "powershell";
	/** 值得告知用户的问题，例如 Termux 环境缺少 `termux-exec`。 */
	warnings: string[];
};

/** 使用系统 `ssh` 连接目标机器所需的信息。 */
export interface SshTarget {
	/** 主机名或 `~/.ssh/config` 中的别名。 */
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** 此应用信任的主机密钥；`acceptHostKey` 会向其中添加密钥。 */
	knownHostsFile: string;
	/** 保存密钥时使用的名称，不受别名、端口和跳板机影响，例如 `pi-env-<env name>`。 */
	hostKeyAlias: string;
	/** `ssh` 程序名称；默认值为 `ssh`。 */
	ssh?: string;
	/** 指定替代 `~/.ssh/config` 的 SSH 配置文件（`-F`）。 */
	configFile?: string;
}

/** 远程主机密钥不在 `knownHostsFile` 中；`scanHostKey` 会显示该密钥，供用户选择是否接受。 */
export class HostKeyUnknownError extends Error {}

/** 远程主机密钥与 `knownHostsFile` 中记录的不一致；绝不会自动接受该密钥。 */
export class HostKeyChangedError extends Error {}

/** 因其他原因失败的 `ssh` 调用，包含退出码和诊断信息。 */
export class SshError extends Error {
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(message: string, exitCode: number | null, stderr: string) {
		super(message);
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** 不得以 `-` 开头（否则会被当作 `ssh` 选项），也不得包含空白字符或控制字符。 */
function checkField(name: string, value: string): void {
	if (value === "" || value.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(value)) {
		throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
	}
}

/** 用于 `ssh` 选项的路径：加引号并将 `%` 视为字面字符，避免展开 `%` 占位符。 */
function configPath(name: string, path: string): string {
	if (path === "" || /["\x00-\x1f\x7f]/.test(path)) throw new Error(`Invalid ${name}: ${JSON.stringify(path)}`);
	return `"${path.replaceAll("%", "%%")}"`;
}

/**
 * `ssh` 中主机之前的参数：不提示、不进行任何转发、不共享连接、不执行配置文件中的命令、不转发区域设置
 *（远端使用自己的设置），并通过固定别名严格使用应用自己的主机密钥文件进行校验。
 */
export function sshArguments(
	target: SshTarget,
	strictHostKeys = true,
	knownHostsFile = target.knownHostsFile,
): string[] {
	checkField("host", target.host);
	checkField("host key alias", target.hostKeyAlias);
	if (target.user !== undefined) checkField("user", target.user);
	if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
		throw new Error(`Invalid port: ${target.port}`);
	}
	const option = (setting: string) => ["-o", setting];
	return [
		...(target.configFile === undefined ? [] : ["-F", target.configFile]),
		"-T",
		"-a",
		"-x",
		...option("BatchMode=yes"),
		...option("ClearAllForwardings=yes"),
		...option("ForwardAgent=no"),
		...option("ForwardX11=no"),
		...option("ControlMaster=no"),
		...option("ControlPath=none"),
		...option("RemoteCommand=none"),
		...option("PermitLocalCommand=no"),
		...option("SendEnv=-*"),
		...option("ServerAliveInterval=15"),
		...option(`StrictHostKeyChecking=${strictHostKeys ? "yes" : "accept-new"}`),
		...option(`UserKnownHostsFile=${configPath("known hosts file", knownHostsFile)}`),
		...option("GlobalKnownHostsFile=none"),
		...option("HashKnownHosts=no"),
		...option(`HostKeyAlias=${target.hostKeyAlias}`),
		...(target.user === undefined ? [] : ["-l", target.user]),
		...(target.port === undefined ? [] : ["-p", String(target.port)]),
		...(target.identityFile === undefined
			? []
			: [
					...option(`IdentityFile=${configPath("identity file", target.identityFile)}`),
					...option("IdentitiesOnly=yes"),
				]),
		"--",
		target.host,
	];
}

/** 通过 `ssh` 执行检测、检查或上传时允许的最长时长；超时后放弃操作。 */
const SSH_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;

/** 通过 `ssh` 运行一条远程命令，可选地向其输入标准输入；成功时返回标准输出，失败时拒绝。 */
function runSsh(
	target: SshTarget,
	command: string,
	options: { stdin?: Uint8Array; args?: string[]; timeoutMs?: number } = {},
): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = options.args ?? sshArguments(target);
		const child = spawn(target.ssh ?? "ssh", [...args, command], { stdio: ["pipe", "pipe", "pipe"] });
		const timeoutMs = options.timeoutMs ?? SSH_TIMEOUT_MS;
		const timer = setTimeout(() => {
			child.kill();
			const diagnostics = Buffer.concat(stderr).toString("utf8");
			reject(
				new SshError(
					`ssh ${target.host} did not finish within ${timeoutMs / 1000} s: ${diagnostics.trim()}`,
					null,
					diagnostics,
				),
			);
		}, timeoutMs);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.stdin.on("error", () => {});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new SshError(error.message, null, ""));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const output = Buffer.concat(stdout).toString("utf8");
			const diagnostics = Buffer.concat(stderr).toString("utf8");
			if (code === 0) return resolve(output);
			if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(diagnostics)) {
				return reject(
					new HostKeyChangedError(`The host key of ${target.host} changed; remove the old key to continue`),
				);
			}
			if (/Host key verification failed|No .* host key is known/.test(diagnostics)) {
				return reject(new HostKeyUnknownError(`The host key of ${target.host} is not trusted yet`));
			}
			reject(
				new SshError(`ssh ${target.host} failed with exit code ${code}: ${diagnostics.trim()}`, code, diagnostics),
			);
		});
		child.stdin.end(options.stdin ?? new Uint8Array(0));
	});
}

/**
 * 使用 `accept-new` 连接一次，并通过临时 known-hosts 文件捕获主机提供的密钥；连接路径与正式连接相同
 *（`~/.ssh/config`、跳板机等）。返回对应的 known-hosts 行和指纹。
 * 显示指纹并不等于完成身份验证：接受密钥前，应将它与通过其他渠道取得的指纹进行比对。
 */
export async function scanHostKey(target: SshTarget): Promise<{ lines: string[]; fingerprints: string[] }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-env-hostkey-"));
	try {
		const scanned = join(directory, "known_hosts");
		// 没有密钥时身份验证可能失败；密钥会在验证之前记录下来。
		await runSsh(target, "exit 0", { args: sshArguments(target, false, scanned) }).catch((error: unknown) => {
			if (!(error instanceof SshError) && !(error instanceof HostKeyUnknownError)) throw error;
		});
		const lines = existsSync(scanned)
			? (await readFile(scanned, "utf8")).split("\n").filter((line) => line.trim() !== "")
			: [];
		if (lines.length === 0) throw new Error(`No host key received from ${target.host}`);
		const fingerprints = await new Promise<string[]>((resolve, reject) => {
			const child = spawn("ssh-keygen", ["-lf", scanned], { stdio: ["ignore", "pipe", "pipe"] });
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString("utf8");
			});
			child.on("error", reject);
			child.on("close", () => resolve(output.split("\n").filter((line) => line.trim() !== "")));
		});
		return { lines, fingerprints };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** `alias` 对应的 known_hosts 行，格式为 `alias type key [comment]`；不接受标记、模式或哈希名称。 */
function parseHostKeyLine(alias: string, line: string): { type: string; key: string } {
	const [host, type, key] = line.trim().split(/\s+/);
	if (
		host !== alias ||
		type === undefined ||
		key === undefined ||
		!/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$/.test(type) ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(key)
	) {
		throw new Error(`Not a host key line for ${alias}: ${JSON.stringify(line)}`);
	}
	return { type, key };
}

/** 正在修改的 known_hosts 文件集合，确保同一文件的修改依次执行。 */
const knownHostsChanges = new Map<string, Promise<unknown>>();

/** 逐项原子地改写 known_hosts 文件。 */
async function changeKnownHosts(file: string, change: (lines: string[]) => string[]): Promise<void> {
	const previous = knownHostsChanges.get(file) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(async () => {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
			const existing = existsSync(file)
				? (await readFile(file, "utf8")).split("\n").filter((line) => line !== "")
				: [];
			const lines = change(existing);
			const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
			await writeFile(temporary, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
			await rename(temporary, file).catch(async (error: unknown) => {
				await rm(temporary, { force: true });
				throw error;
			});
		});
	knownHostsChanges.set(file, next);
	try {
		await next;
	} finally {
		if (knownHostsChanges.get(file) === next) knownHostsChanges.delete(file);
	}
}

/**
 * 将 `scanHostKey` 返回的主机密钥行加入目标的 known-hosts 文件，以信任这些密钥。只接受目标别名对应的普通行。
 * 如果密钥与已信任的同类型密钥不一致，则以 `HostKeyChangedError` 拒绝；必须先通过 `forgetHostKey` 删除旧密钥。
 */
export async function acceptHostKey(target: SshTarget, lines: readonly string[]): Promise<void> {
	const alias = target.hostKeyAlias;
	const accepted = lines.map((line) => ({ line: line.trim(), ...parseHostKeyLine(alias, line) }));
	await changeKnownHosts(target.knownHostsFile, (existing) => {
		const trusted = new Map<string, string>();
		for (const line of existing) {
			const [host, type, key] = line.trim().split(/\s+/);
			if (host === alias && type !== undefined && key !== undefined) trusted.set(type, key);
		}
		const added: string[] = [];
		for (const { line, type, key } of accepted) {
			const known = trusted.get(type);
			if (known === key) continue;
			if (known !== undefined) {
				throw new HostKeyChangedError(`The ${type} host key of ${target.host} changed; forget the old key first`);
			}
			trusted.set(type, key);
			added.push(line);
		}
		return [...existing, ...added];
	});
}

/** 停止信任为目标别名保存的所有密钥，例如用户确认主机密钥已变更后。 */
export async function forgetHostKey(target: SshTarget): Promise<void> {
	await changeKnownHosts(target.knownHostsFile, (existing) =>
		existing.filter((line) => line.trim().split(/\s+/)[0] !== target.hostKeyAlias),
	);
}

/** 由远程登录 shell 执行的 POSIX 环境检测；Windows 主机则通过 PowerShell 返回结果。 */
const POSIX_PROBE = `sh -c 'echo PI-ENV-PROBE; uname -s; uname -m; uname -o 2>/dev/null || echo -; printf "%s\\n" "$HOME" "\${TMPDIR:--}" "\${LD_PRELOAD:--}"'`;

function powershell(script: string): string {
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

const WINDOWS_PROBE = powershell(
	"'PI-ENV-PROBE'; 'Windows'; [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); '-'; $HOME; '-'; '-'",
);

function normalizeArch(machine: string): RemotePlatform["arch"] {
	const lower = machine.toLowerCase();
	if (lower === "x86_64" || lower === "amd64" || lower === "x64") return "x64";
	if (lower === "aarch64" || lower === "arm64") return "arm64";
	throw new Error(`Unsupported remote architecture: ${machine}`);
}

type Probe = { system: string; machine: string; os: string; home: string; tmpdir: string; preload: string };

function parseProbe(target: SshTarget, output: string): Probe {
	// 登录 shell 可能会先输出欢迎信息。
	const lines = output.split(/\r?\n/);
	const start = lines.indexOf("PI-ENV-PROBE");
	if (start === -1) throw new Error(`Unexpected answer from ${target.host}: ${output.trim()}`);
	const [system = "", machine = "", os = "", home = "", tmpdir = "-", preload = "-"] = lines.slice(start + 1);
	return { system, machine, os, home, tmpdir, preload };
}

/** Termux 仅在使用自身的 `TMPDIR` 且安装 `termux-exec` 时可正常工作；后者用于支持 `#!/usr/bin/env` 脚本解释器声明。 */
function termuxWarnings(probe: Probe): string[] {
	const warnings: string[] = [];
	if (probe.tmpdir === "-") warnings.push("TMPDIR is not set; Termux's sshd normally sets it to $PREFIX/tmp.");
	if (!probe.preload.includes("termux-exec")) {
		warnings.push("termux-exec is not loaded (LD_PRELOAD); scripts with #!/usr/bin/env shebangs will fail.");
	}
	warnings.push("Android may suspend Termux; run termux-wake-lock on the device to keep the connection alive.");
	return warnings;
}

/** 目标机器运行的系统：通过登录 shell 执行 `uname` 检测，Windows 上则使用 PowerShell。 */
export async function detectPlatform(target: SshTarget): Promise<RemotePlatform> {
	let probe: Probe;
	try {
		probe = parseProbe(target, await runSsh(target, POSIX_PROBE));
	} catch (error) {
		// 远程 shell 是 cmd.exe 或 PowerShell：没有 `sh`，或 `sh` 对探测命令的引号处理不正确。
		if (error instanceof HostKeyUnknownError || error instanceof HostKeyChangedError) throw error;
		probe = parseProbe(target, await runSsh(target, WINDOWS_PROBE));
	}
	// Windows 默认 SSH shell 为 Git Bash 时，通过 PowerShell 获取 Windows 自身的架构和主目录写法。
	if (/^(MINGW|MSYS|CYGWIN)/.test(probe.system)) probe = parseProbe(target, await runSsh(target, WINDOWS_PROBE));
	const arch = normalizeArch(probe.machine);
	const { system, os, home } = probe;
	if (system === "Windows") {
		// cmd.exe 会展开 %OS%；PowerShell 则按原样输出。
		const shell = (await runSsh(target, "echo %OS%")).includes("Windows_NT") ? "cmd" : "powershell";
		return { platform: "windows", arch, home, shell, warnings: [] };
	}
	if (system === "Darwin") return { platform: "darwin", arch, home, warnings: [] };
	if (system === "Linux") {
		const android = os === "Android";
		return { platform: android ? "android" : "linux", arch, home, warnings: android ? termuxWarnings(probe) : [] };
	}
	throw new Error(`Unsupported remote system: ${system}`);
}

/** 此软件包为远程系统提供的守护进程二进制文件。 */
export function packagedDaemon(remote: Pick<RemotePlatform, "platform" | "arch">): string {
	const name = `pi-env-${remote.platform}-${remote.arch}`;
	return join(packageRoot, "bin", name, remote.platform === "windows" ? "pi-env.exe" : "pi-env");
}

function quotePosix(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

function quotePowerShell(text: string): string {
	return `'${text.replaceAll("'", "''")}'`;
}

/** 远程机器上保存此内容对应守护进程的位置；使用 SHA-256 命名，避免不同版本冲突。 */
function daemonPath(remote: RemotePlatform, sha256: string): string {
	const name = `pi-env-${sha256.slice(0, 32)}`;
	return remote.platform === "windows"
		? `${remote.home}\\.pi\\mobile\\tools\\${name}.exe`
		: `${remote.home}/.pi/mobile/tools/${name}`;
}

const POSIX_HASH = `hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'; else echo none; fi; }`;

/** 远程文件是否具有此内容：`present`、`missing`，或在没有哈希工具的 POSIX 系统上为 `nohash`。 */
async function checkDaemon(target: SshTarget, remote: RemotePlatform, file: string, sha256: string): Promise<string> {
	if (remote.platform === "windows") {
		const check = powershell(
			`$f = ${quotePowerShell(file)}; if ((Test-Path -LiteralPath $f) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() -eq '${sha256}')) { 'present' } else { 'missing' }`,
		);
		return (await runSsh(target, check)).trim().endsWith("present") ? "present" : "missing";
	}
	const check = `${POSIX_HASH}; f=${quotePosix(file)}; if [ -f "$f" ] && [ "$(hash "$f")" = ${sha256} ]; then echo present; elif [ "$(hash /dev/null)" = none ]; then echo nohash; else echo missing; fi`;
	return (await runSsh(target, `sh -c ${quotePosix(check)}`)).trim().split("\n").at(-1) ?? "missing";
}

/**
 * 确保远程机器上存在守护进程，并在其运行前校验 SHA-256；同时清理内容不同的旧守护进程。
 * 上传内容先写入新的临时文件，只有哈希匹配后才会重命名到目标位置。
 * 返回远程二进制文件的路径。
 */
export async function deployDaemon(
	target: SshTarget,
	remote: RemotePlatform,
	binary = packagedDaemon(remote),
): Promise<string> {
	if (!existsSync(binary)) throw new Error(`No pi-env daemon for ${remote.platform}-${remote.arch} at ${binary}`);
	const bytes = await readFile(binary);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const file = daemonPath(remote, sha256);
	const state = await checkDaemon(target, remote, file, sha256);
	if (state === "present") return file;
	if (state === "nohash") throw new Error(`${target.host} has no sha256sum, shasum or openssl to verify pi-env`);
	if (remote.platform === "windows") {
		const upload = powershell(
			[
				"$ErrorActionPreference = 'Stop'",
				`$f = ${quotePowerShell(file)}`,
				"$d = Split-Path -Parent $f",
				"New-Item -ItemType Directory -Force -Path $d | Out-Null",
				"$t = Join-Path $d ('.pi-env-' + [guid]::NewGuid().ToString() + '.tmp')",
				// PowerShell 会自行读取重定向的标准输入，并将其作为文本行提供给 `$input`，因此二进制内容以 Base64 行传入，
				// 直到遇到结束标记：Windows 的 sshd 可能不会传递标准输入的结束信号。
				"$text = New-Object System.Text.StringBuilder",
				"foreach ($line in $input) { if ($line -eq 'PI-ENV-END') { break }; [void]$text.Append($line) }",
				"$bytes = [Convert]::FromBase64String($text.ToString())",
				"$out = [IO.File]::Open($t, 'CreateNew', 'Write', 'None'); $out.Write($bytes, 0, $bytes.Length); $out.Close()",
				`if ((Get-FileHash -Algorithm SHA256 -LiteralPath $t).Hash.ToLower() -ne '${sha256}') { Remove-Item -LiteralPath $t; throw 'pi-env upload is corrupt' }`,
				// 正在运行的守护进程或病毒扫描程序可能会暂时占用旧文件。
				"for ($i = 0; ; $i++) { try { Move-Item -Force -LiteralPath $t -Destination $f; break } catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 250 } }",
				// 清理旧版守护进程；仍在运行的实例会保留到退出为止。
				"Get-ChildItem -LiteralPath $d -Filter 'pi-env-*.exe' | Where-Object { $_.FullName -ne $f } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -ErrorAction SilentlyContinue }",
				"'deployed'",
			].join("; "),
		);
		const lines = bytes.toString("base64").replace(/.{1,76}/g, "$&\n");
		await runSsh(target, upload, { stdin: Buffer.from(`${lines}PI-ENV-END\n`), timeoutMs: UPLOAD_TIMEOUT_MS });
		return file;
	}
	const upload = [
		"set -e",
		POSIX_HASH,
		`f=${quotePosix(file)}`,
		'd=$(dirname "$f")',
		'mkdir -p "$d"',
		'chmod 700 "$d"',
		't=$(mktemp "$d/.pi-env.XXXXXX")',
		'cat > "$t"',
		`if [ "$(hash "$t")" != ${sha256} ]; then rm -f "$t"; echo "pi-env upload is corrupt" >&2; exit 1; fi`,
		'chmod 700 "$t"',
		'mv -f "$t" "$f"',
		// 清理旧版守护进程；仍在运行的实例会一直打开文件，直到退出为止。
		'for old in "$d"/pi-env-*; do [ "$old" = "$f" ] || rm -f "$old"; done',
		"echo deployed",
	].join("\n");
	await runSsh(target, `sh -c ${quotePosix(upload)}`, { stdin: bytes, timeoutMs: UPLOAD_TIMEOUT_MS });
	return file;
}

/** `sshConnection` 和 `connectSsh` 的选项：目标信息及要部署的二进制文件（默认使用此软件包提供的文件）。 */
export interface SshConnectOptions extends SshTarget {
	binary?: string;
	/**
	 * POSIX：通过用户的登录 shell（`$SHELL -l`）启动守护进程，使命令可以获取 `~/.profile` 等文件中的环境配置。
	 * 默认关闭：`ssh` 执行命令时不会使用登录 shell。
	 */
	loginShell?: boolean;
	onLog?: ConnectionOptions["onLog"];
}

/** 在 `serve` 参数之前，用于启动 `file` 处守护进程的远程命令。 */
function launchCommand(remote: RemotePlatform, file: string, loginShell: boolean): string {
	if (remote.platform === "windows") {
		// PowerShell 只有通过调用运算符才能执行带引号的路径；cmd.exe 会保留程序路径外的一对引号。
		if (remote.shell === "powershell") return `& ${quotePowerShell(file)}`;
		return file.includes(" ") ? `"${file}"` : file;
	}
	// `$0` 表示守护进程，`"$@"` 表示其参数；`$SHELL` 是登录 shell 自身报告的名称。
	if (loginShell) return `exec "$SHELL" -lc 'exec "$0" "$@"' ${quotePosix(file)}`;
	return quotePosix(file);
}

/** SSH 连接检测到的远程系统信息，以及最近一次验证过的守护进程。 */
type SshState = { remote?: RemotePlatform; verified?: string };

/** 每次启动时都会先检测远程系统（仅检测一次）、验证或部署守护进程，然后启动守护进程的 `Connection`。 */
function sshConnectionFor(options: SshConnectOptions, state: SshState): Connection {
	return new Connection({
		command: async () => {
			if (state.remote === undefined) {
				const remote = await detectPlatform(options);
				for (const warning of remote.warnings) options.onLog?.(`${warning}\n`);
				state.remote = remote;
			}
			// 刚刚完成二进制校验的部署可直接用于首次启动。
			const file =
				state.verified ??
				(await deployDaemon(options, state.remote, options.binary ?? packagedDaemon(state.remote)));
			state.verified = undefined;
			return [
				options.ssh ?? "ssh",
				...sshArguments(options),
				launchCommand(state.remote, file, options.loginShell === true),
			];
		},
		...(options.onLog === undefined ? {} : { onLog: options.onLog }),
	});
}

/**
 * 到目标的 `Connection`，在收到首个请求前不会执行操作。每次启动时会检测远程系统（仅首次检测），
 * 校验守护进程；如果它不存在或已变化，则部署后通过 `ssh` 启动。启动失败时（例如网络不可用，或主机密钥不受信任、已变化），
 * 等待该次启动的请求会以 `spawn_error` 错误码失败，并附带 `ssh` 诊断信息；后续请求会重试。
 * 检测完成后，`remote()` 会返回远程系统信息。
 */
export function sshConnection(options: SshConnectOptions): {
	connection: Connection;
	remote(): RemotePlatform | undefined;
} {
	const state: SshState = {};
	return { connection: sshConnectionFor(options, state), remote: () => state.remote };
}

/**
 * 立即检测远程系统并部署守护进程，然后返回一个通过 `ssh` 启动它的 `Connection`，其行为与 `sshConnection` 相同。
 * 故障会在此处直接拒绝：主机密钥必须已受信任（通过 `scanHostKey` 和 `acceptHostKey`），否则会以
 * `HostKeyUnknownError` 拒绝。
 */
export async function connectSsh(
	options: SshConnectOptions,
): Promise<{ connection: Connection; remote: RemotePlatform }> {
	const remote = await detectPlatform(options);
	const verified = await deployDaemon(options, remote, options.binary ?? packagedDaemon(remote));
	for (const warning of remote.warnings) options.onLog?.(`${warning}\n`);
	return { connection: sshConnectionFor(options, { remote, verified }), remote };
}
