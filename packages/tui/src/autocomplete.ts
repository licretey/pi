import { spawn } from "child_process";
import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { fuzzyFilter } from "./fuzzy.ts";
import { autocompleteBoundaryRegex, autocompleteSeparatorRegex } from "./utils.ts";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const tokenStartRegex = new RegExp(`${autocompleteBoundaryRegex.source}$`, "u");
// 正文中出现在路径之前的开始型包裹符，映射到对应的结束符。
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

function toDisplayPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) {
		return normalized;
	}

	const hasTrailingSeparator = normalized.endsWith("/");
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	if (!trimmed) {
		return normalized;
	}

	const separatorPattern = "[\\\\/]";
	const segments = trimmed
		.split("/")
		.filter(Boolean)
		.map((segment) => escapeRegex(segment));
	if (segments.length === 0) {
		return normalized;
	}

	let pattern = segments.join(separatorPattern);
	if (hasTrailingSeparator) {
		pattern += separatorPattern;
	}
	return pattern;
}

function findLastDelimiter(text: string): number {
	let lastDelimiter = -1;
	let index = 0;
	for (const character of text) {
		index += character.length;
		if (PATH_DELIMITERS.has(character) || autocompleteSeparatorRegex.test(character)) {
			lastDelimiter = index - 1;
		}
	}
	return lastDelimiter;
}

// 去掉路径前面的开始型包裹符，例如 "(~/Dev" -> "~/Dev" 或 "`src/ma" -> "src/ma"。
// 若 token 中同时含有对应的结束符则保留包裹符，例如 "app/[slug]/pa" 或 "(group)/pa"。
function stripLeadingWrappers(token: string): string {
	let result = token;
	while (result.length > 0) {
		const closer = PATH_WRAPPERS[result[0]!];
		if (!closer || result.includes(closer, 1)) {
			break;
		}
		result = result.slice(1);
	}
	return result;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	let start = index;
	while (start > 0 && PATH_WRAPPERS[text[start - 1]!]) {
		start -= 1;
	}
	return PATH_DELIMITERS.has(text[start - 1] ?? "") || tokenStartRegex.test(text.slice(0, start));
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function buildCompletionValue(
	path: string,
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
	const needsQuotes = options.isQuotedPrefix || autocompleteSeparatorRegex.test(path);
	const prefix = options.isAtPrefix ? "@" : "";

	if (!needsQuotes) {
		return `${prefix}${path}`;
	}

	const openQuote = `${prefix}"`;
	const closeQuote = '"';
	return `${openQuote}${path}${closeQuote}`;
}

// 用 fd 遍历目录树（快，且遵守 .gitignore）
async function walkDirectoryWithFd(
	baseDir: string,
	fdPath: string,
	query: string,
	maxResults: number,
	signal: AbortSignal,
	maxDepth?: number,
): Promise<Array<{ path: string; isDirectory: boolean }>> {
	const args = [
		"--base-directory",
		baseDir,
		"--max-results",
		String(maxResults),
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		"--exclude",
		".git",
		"--exclude",
		".git/*",
		"--exclude",
		".git/**",
	];

	if (maxDepth !== undefined) {
		args.push("--max-depth", String(maxDepth));
	}

	if (toDisplayPath(query).includes("/")) {
		args.push("--full-path");
	}

	if (query) {
		args.push(buildFdPathQuery(query));
	}

	return await new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}

		const child = spawn(fdPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let resolved = false;

		const finish = (results: Array<{ path: string; isDirectory: boolean }>) => {
			if (resolved) return;
			resolved = true;
			signal.removeEventListener("abort", onAbort);
			resolve(results);
		};

		const onAbort = () => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		};

		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			finish([]);
		});
		child.on("close", (code) => {
			if (signal.aborted || code !== 0 || !stdout) {
				finish([]);
				return;
			}

			const lines = stdout.trim().split("\n").filter(Boolean);
			const results: Array<{ path: string; isDirectory: boolean }> = [];

			for (const line of lines) {
				const displayLine = toDisplayPath(line);
				const hasTrailingSeparator = displayLine.endsWith("/");
				const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
				if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) {
					continue;
				}

				results.push({
					path: displayLine,
					isDirectory: hasTrailingSeparator,
				});
			}

			finish(results);
		});
	});
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	// 获取本命令的参数补全的函数
	// 无可用参数补全时返回 null
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string; // 我们正在匹配的对象（例如 "/" 或 "src/"）
}

export interface AutocompleteProvider {
	/** 在 token 边界自然触发本 provider 的字符。 */
	triggerCharacters?: string[];

	// 针对当前文本/光标位置获取自动补全建议
	// 无可用建议时返回 null
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;

	// 应用选中的条目
	// 返回新文本与光标位置
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};

	// 检查按 Tab 显式触发时是否应启动文件补全
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

// 同时处理 slash 命令与文件路径的组合 provider
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private fdPath: string | null;

	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string, fdPath: string | null = null) {
		this.commands = commands;
		this.basePath = basePath;
		this.fdPath = fdPath;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const atPrefix = this.extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			const suggestions = await this.getFuzzyFileSuggestions(rawPrefix, {
				isQuotedPrefix,
				signal: options.signal,
			});
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
			};
		}

		const commandText = textBeforeCursor.trimStart();
		if (!options.force && commandText.startsWith("/")) {
			const spaceIndex = commandText.indexOf(" ");

			if (spaceIndex === -1) {
				const prefix = commandText.slice(1);
				const commandItems = this.commands.map((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
					const desc = cmd.description ?? "";
					const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
					return {
						name,
						label: name,
						description: fullDesc || undefined,
					};
				});

				const bareNameMatches = fuzzyFilter(commandItems, prefix, (item) =>
					item.name.startsWith("skill:") ? item.name.slice("skill:".length) : item.name,
				);
				const bareNameMatchSet = new Set(bareNameMatches);
				const fullNameOnlyMatches = fuzzyFilter(
					commandItems.filter((item) => item.name.startsWith("skill:") && !bareNameMatchSet.has(item)),
					prefix,
					(item) => item.name,
				);
				const filtered = [...bareNameMatches, ...fullNameOnlyMatches].map((item) => ({
					value: item.name,
					label: item.label,
					...(item.description && { description: item.description }),
				}));

				if (filtered.length === 0) return null;

				return {
					items: filtered,
					prefix: commandText,
				};
			}

			const commandName = commandText.slice(1, spaceIndex);
			const argumentText = commandText.slice(spaceIndex + 1);

			const command = this.commands.find((cmd) => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				return name === commandName;
			});
			if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
				return null;
			}

			const argumentSuggestions = await command.getArgumentCompletions(argumentText);
			if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
				return null;
			}

			return {
				items: argumentSuggestions,
				prefix: argumentText,
			};
		}

		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		if (pathMatch === null) {
			return null;
		}

		const suggestions = this.getFileSuggestions(pathMatch);
		if (suggestions.length === 0) return null;

		return {
			items: suggestions,
			prefix: pathMatch,
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
		const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
		const hasTrailingQuoteInItem = item.value.endsWith('"');
		const adjustedAfterCursor =
			isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;

		// 检查正在补全的是否为 slash 命令（prefix 以 "/" 开头，但不是文件路径）
		// slash 命令位于行首，且第一个 / 之后不含路径分隔符
		const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
		if (isSlashCommand) {
			// 这是命令名补全
			const newLine = `${beforePrefix}/${item.value} ${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 对应 "/" 和空格
			};
		}

		// 检查正在补全的是否为文件附件（prefix 以 "@" 开头）
		if (prefix.startsWith("@")) {
			// 这是文件附件补全
			// 目录后不加空格，让用户可以继续自动补全
			const isDirectory = item.label.endsWith("/");
			const suffix = isDirectory ? "" : " ";
			const newLine = `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset + suffix.length,
			};
		}

		// 检查是否处于 slash 命令上下文（beforePrefix 含 "/command "）
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// 这大概率是命令参数补全
			const newLine = beforePrefix + item.value + adjustedAfterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const isDirectory = item.label.endsWith("/");
			const hasTrailingQuote = item.value.endsWith('"');
			const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset,
			};
		}

		// 文件路径：补全该路径
		const newLine = beforePrefix + item.value + adjustedAfterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		const isDirectory = item.label.endsWith("/");
		const hasTrailingQuote = item.value.endsWith('"');
		const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + cursorOffset,
		};
	}

	// 为模糊文件建议提取 @ 前缀
	private extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const token = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		if (token.startsWith("@")) {
			return token;
		}

		return null;
	}

	// 从光标前的文本中提取类似路径的前缀
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));

		// 强制提取时（Tab 键），总是返回结果
		if (forceExtract) {
			return pathPrefix;
		}

		// 自然触发时，只有看起来像路径、以 / 结尾或以 ~/、. 开头才返回。
		// 只有当文本像是正要进入路径上下文时，才返回空字符串。
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// 在空白或 CJK 标点之后返回空前缀，但空文本除外。
		// 空文本不应触发文件建议——那是强制 Tab 补全的职责。
		if (pathPrefix === "" && text !== "" && tokenStartRegex.test(text)) {
			return pathPrefix;
		}

		return null;
	}

	// 把主目录（~/）展开为实际的主目录路径
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// 若原路径以 / 结尾，则保留该斜杠
			return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	private resolveScopedFuzzyQuery(rawQuery: string): { baseDir: string; query: string; displayBase: string } | null {
		const normalizedQuery = toDisplayPath(rawQuery);
		const slashIndex = normalizedQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = normalizedQuery.slice(0, slashIndex + 1);
		const query = normalizedQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = join(this.basePath, displayBase);
		}

		try {
			if (!statSync(baseDir).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	private scopedPathForDisplay(displayBase: string, relativePath: string): string {
		const normalizedRelativePath = toDisplayPath(relativePath);
		if (displayBase === "/") {
			return `/${normalizedRelativePath}`;
		}
		return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
	}

	// 为给定路径前缀获取文件/目录建议
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir: string;
			let searchPrefix: string;
			const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
			let expandedPrefix = rawPrefix;

			// 处理主目录展开
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			const isRootPrefix =
				rawPrefix === "" ||
				rawPrefix === "./" ||
				rawPrefix === "../" ||
				rawPrefix === "~" ||
				rawPrefix === "~/" ||
				rawPrefix === "/" ||
				(isAtPrefix && rawPrefix === "");

			if (isRootPrefix) {
				// 从指定位置开始补全
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (rawPrefix.endsWith("/")) {
				// 若 prefix 以 / 结尾，显示该目录的内容
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// 拆分为目录部分与文件前缀
				const dir = dirname(expandedPrefix);
				const file = basename(expandedPrefix);
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = dir;
				} else {
					searchDir = join(this.basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = readdirSync(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				// 检查条目是否为目录（或指向目录的符号链接）
				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = join(searchDir, entry.name);
						isDirectory = statSync(fullPath).isDirectory();
					} catch {
						// 符号链接断裂或权限错误——按文件处理
					}
				}

				let relativePath: string;
				const name = entry.name;
				const displayPrefix = rawPrefix;

				if (displayPrefix.endsWith("/")) {
					// 若 prefix 以 / 结尾，把条目追加到 prefix 之后
					relativePath = displayPrefix + name;
				} else if (displayPrefix.includes("/") || displayPrefix.includes("\\")) {
					// 保留主目录路径的 ~/ 格式
					if (displayPrefix.startsWith("~/")) {
						const homeRelativeDir = displayPrefix.slice(2); // 去掉 ~/
						const dir = dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : join(dir, name)}`;
					} else if (displayPrefix.startsWith("/")) {
						// 绝对路径——正确构造
						const dir = dirname(displayPrefix);
						if (dir === "/") {
							relativePath = `/${name}`;
						} else {
							relativePath = `${dir}/${name}`;
						}
					} else {
						relativePath = join(dirname(displayPrefix), name);
						// path.join 会把 ./ 前缀规范化掉，此处保留它
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							relativePath = `./${relativePath}`;
						}
					}
				} else {
					// 独立条目：若原 prefix 是 ~/，则保留 ~/
					if (displayPrefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				relativePath = toDisplayPath(relativePath);
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, {
					isDirectory,
					isAtPrefix,
					isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			// 目录优先排序，其余按字母顺序
			suggestions.sort((a, b) => {
				const aIsDir = a.label.endsWith("/");
				const bIsDir = b.label.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch (_e) {
			// 目录不存在或不可访问
			return [];
		}
	}

	// 把条目与查询打分（越高 = 匹配越好）
	// isDirectory 会加分，使文件夹更靠前
	private scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
		const fileName = basename(filePath);
		const lowerFileName = fileName.toLowerCase();
		const lowerQuery = query.toLowerCase();

		let score = 0;

		// 文件名完全匹配（最高）
		if (lowerFileName === lowerQuery) score = 100;
		// 文件名以查询开头
		else if (lowerFileName.startsWith(lowerQuery)) score = 80;
		// 文件名中的子串匹配
		else if (lowerFileName.includes(lowerQuery)) score = 50;
		// 完整路径中的子串匹配
		else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

		// 目录获得加分以排在前面
		if (isDirectory && score > 0) score += 10;

		return score;
	}

	private async getBaseDirSuggestions(
		baseDir: string,
		query: string,
		signal: AbortSignal,
	): Promise<Array<{ path: string; isDirectory: boolean }>> {
		if (!this.fdPath || signal.aborted) {
			return [];
		}

		return await walkDirectoryWithFd(baseDir, this.fdPath, query, 100, signal, 1);
	}

	// 用 fd 做模糊文件搜索（快，且遵守 .gitignore）
	private async getFuzzyFileSuggestions(
		query: string,
		options: { isQuotedPrefix: boolean; signal: AbortSignal },
	): Promise<AutocompleteItem[]> {
		if (!this.fdPath || options.signal.aborted) {
			return [];
		}

		try {
			const scopedQuery = this.resolveScopedFuzzyQuery(query);
			const fdBaseDir = scopedQuery?.baseDir ?? this.basePath;
			const fdQuery = scopedQuery?.query ?? query;
			const baseDirEntries = await this.getBaseDirSuggestions(fdBaseDir, fdQuery, options.signal);
			const recursiveEntries = await walkDirectoryWithFd(fdBaseDir, this.fdPath, fdQuery, 100, options.signal);
			const seenPaths = new Set(baseDirEntries.map((entry) => entry.path));
			const entries = [
				...baseDirEntries,
				...recursiveEntries.filter((entry) => {
					if (seenPaths.has(entry.path)) return false;
					seenPaths.add(entry.path);
					return true;
				}),
			];
			if (options.signal.aborted) {
				return [];
			}

			const scoredEntries = entries
				.map((entry) => ({
					...entry,
					score: fdQuery ? this.scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
				}))
				.filter((entry) => entry.score > 0);

			scoredEntries.sort((a, b) => {
				const scoreDiff = b.score - a.score;
				if (scoreDiff !== 0) return scoreDiff;

				const aDepth = toDisplayPath(a.path).split("/").filter(Boolean).length;
				const bDepth = toDisplayPath(b.path).split("/").filter(Boolean).length;
				const depthDiff = aDepth - bDepth;
				if (depthDiff !== 0) return depthDiff;

				const lengthDiff = a.path.length - b.path.length;
				if (lengthDiff !== 0) return lengthDiff;

				return a.path.localeCompare(b.path);
			});
			const topEntries = scoredEntries.slice(0, 20);

			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? this.scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, {
					isDirectory,
					isAtPrefix: true,
					isQuotedPrefix: options.isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}

			return suggestions;
		} catch {
			return [];
		}
	}

	// 检查是否应触发文件补全（按 Tab 键时调用）
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// 正在行首输入 slash 命令时不触发
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}
}
