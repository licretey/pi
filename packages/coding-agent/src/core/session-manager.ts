import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	getCurrentSystemMessage,
	type ImageContent,
	type Message,
	type SystemMessage,
	type TextContent,
	type ToolResultMessage,
	type Usage,
	type UserMessage,
	uuidv7,
} from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	type Stats,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { basename, join, resolve } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";
import { APP_NAME, getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";
export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
	type: "session";
	version?: number; // v1 会话没有此字段。
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface UsageEntry extends SessionEntryBase {
	type: "usage";
	/** 任意 usage 类别，例如 "cache_warm"。 */
	kind: string;
	provider: string;
	model: string;
	usage: Usage;
	/** usage 通知可选的人类可读补充说明。 */
	note?: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** 扩展专属数据（如 ArtifactIndex、structured compaction 的版本标记） */
	details?: T;
	/** 生成此 summary 的 LLM 调用的 usage（如有） */
	usage?: Usage;
	/** 由 extension 生成时为 true；pi 生成时为 undefined/false（向后兼容） */
	fromHook?: boolean;
	/** 此 compaction 边界处的完整 prompt 和 tool state。 */
	systemMessage?: SystemMessage;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** 扩展专属数据（不发送给 LLM） */
	details?: T;
	/** 生成此 summary 的 LLM 调用的 usage（如有） */
	usage?: Usage;
	/** 由 extension 生成时为 true，pi 生成时为 false */
	fromHook?: boolean;
}

/**
 * 供 extension 在会话中存储扩展专属数据的 custom entry。
 * 用 customType 标识你的 extension 的 entries。
 *
 * 用途：跨会话重载持久化 extension 状态。重载时 extension 可
 * 扫描 entries 中的 customType 来重建内部状态。
 *
 * 不参与 LLM context（被 buildSessionContext 忽略）。
 * 要向 context 注入内容，见 CustomMessageEntry。
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/** 为 entry 提供用户自定义书签/标记的 label entry。 */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** 会话元数据 entry（如用户定义的显示名）。 */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

/**
 * 供 extension 向 LLM context 注入消息的 custom message entry。
 * 用 customType 标识你的 extension 的 entries。
 *
 * 与 CustomEntry 不同，它参与 LLM context。
 * 其 content 在 buildSessionContext() 中转换为 user 消息。
 * details 用于扩展专属元数据（不发送给 LLM）。
 *
 * display 控制 TUI 渲染：
 * - false：完全隐藏
 * - true：以独特样式渲染（区别于 user 消息）
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

/** 追加式 context edit 可以替换的内容——不改变消息元数据。 */
export type ContextEditableContent =
	| UserMessage["content"]
	| AssistantMessage["content"]
	| ToolResultMessage["content"]
	| CustomMessage["content"];

/** 对某个更早 entry 所贡献的 model context 的追加式修改。 */
export interface ContextEditEntry extends SessionEntryBase {
	type: "context_edit";
	targetId: string;
	/** 为 null 时把 target 从 model context 中省去。为值时仅替换其 content。 */
	replacement: { content: ContextEditableContent } | null;
}

/** session entry——带 id/parentId 的树形结构（由 SessionManager 的 "read" 方法返回） */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| UsageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| ContextEditEntry
	| LabelEntry
	| SessionInfoEntry;

/** 原始文件 entry（含 header） */
export type FileEntry = SessionHeader | SessionEntry;

/** getTree() 用的树节点——session 结构的防御性拷贝 */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** 此 entry 已解析的 label（如有） */
	label?: string;
	/** 此 entry 最近一次 label 变更的时间戳（如有） */
	labelTimestamp?: string;
}

export interface ProjectedSessionEntry {
	/** 拥有此投射贡献的原始追加式 entry。 */
	sourceEntry: SessionEntry;
	/** context edits 之后模型可见的 messages。纯状态 entry 与省略项为空。 */
	messages: AgentMessage[];
}

export interface SessionProjection {
	entries: ProjectedSessionEntry[];
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionInfo {
	path: string;
	id: string;
	/** 会话启动时所在的工作目录。旧会话为空字符串。 */
	cwd: string;
	/** session_info entries 中用户定义的显示名。 */
	name?: string;
	/** 父会话的路径（若本会话由 fork 而来）。 */
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "buildContextEntries"
	| "buildSessionProjection"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** 生成唯一的短 ID（8 个十六进制字符，做碰撞检查） */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// 万一出现碰撞，退回到完整 UUID
	return randomUUID();
}

/** v1 → v2 迁移：添加 id/parentId 树形结构。就地修改。 */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// 为 compaction 把 firstKeptEntryIndex 转换为 firstKeptEntryId
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** v2 → v3 迁移：把 hookMessage role 改名为 custom。就地修改。 */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// 把 role 为 hookMessage 的 message entry 更新为 custom
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * 运行所有必要的迁移，把 entries 升级到当前版本。
 * 就地修改 entries。有任何迁移被应用时返回 true。
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

/** 为测试导出 */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

/** 为 compaction.test.ts 导出 */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// 跳过格式错误的行
		}
	}

	return entries;
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) {
		index.set(entry.id, entry);
	}
	return index;
}

function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	leaf ??= entries[entries.length - 1];
	if (!leaf) {
		return [];
	}

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/**
 * 把选中的一个 session entry 投射为 LLM/运行时 messages。
 * 普通 custom entry 是展示/状态 entry，不参与 context。
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		// session 文件解析时不做校验；旧版本、fork 或手工编辑过的文件
		// 可能包含 content 为 null/缺失的消息。
		if (message.role === "system" && message.content == null) return [{ ...message, content: "" }];
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		const summary = createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		return entry.systemMessage ? [entry.systemMessage, summary] : [summary];
	}
	return [];
}

/**
 * 构建活跃的、感知 compaction 的 session entry 列表。
 *
 * 沿当前 leaf 路径走。若路径上有 compaction entries，则最新的
 * compaction 由 compaction entry 本身代表，随后是从
 * firstKeptEntryId 开始的保留 entries 以及 compaction entry 之后的所有
 * entries。更早的已摘要 entries 被省略。
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return path;
	}

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

/**
 * 通过树遍历从 entries 构建 session context。
 * 提供了 leafId 时从该 entry 走到 root。
 * 处理路径上的 compaction 与 branch summary。
 */
function projectContextEntry(entry: SessionEntry, edit: ContextEditEntry | undefined): AgentMessage[] {
	const messages = sessionEntryToContextMessages(entry);
	if (!edit) return messages;
	const replacement = edit.replacement;
	if (replacement === null) return [];

	return messages.map((message) => {
		if (
			message.role !== "user" &&
			message.role !== "assistant" &&
			message.role !== "toolResult" &&
			message.role !== "custom"
		) {
			return message;
		}
		const content =
			(message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string"
				? [{ type: "text" as const, text: replacement.content }]
				: replacement.content;
		return { ...message, content } as AgentMessage;
	});
}

/** 构建保留来源信息的、感知 compaction 的 model context。 */
export function buildSessionProjection(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionProjection {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const contextEntries = buildContextEntries(entries, leafId, byId);
	const edits = new Map<string, ContextEditEntry>();
	for (const entry of contextEntries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}
	const projectedEntries = contextEntries.map(
		(sourceEntry, index): ProjectedSessionEntry => ({
			sourceEntry,
			// buildContextEntries() 可能保留一个更早的 compaction entry，因为它的
			// 原始 ID 落在最新保留范围内。只有索引 0 处的最新 compaction
			// 会贡献 checkpoint 和 summary。
			messages:
				sourceEntry.type === "compaction" && index > 0
					? []
					: projectContextEntry(sourceEntry, edits.get(sourceEntry.id)),
		}),
	);
	return {
		entries: projectedEntries,
		messages: projectedEntries.flatMap((entry) => entry.messages),
		thinkingLevel,
		model,
	};
}

/** 从规范的 session projection 构建最终定稿的 model context。 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const { messages, thinkingLevel, model } = buildSessionProjection(entries, leafId, byId);
	return { messages, thinkingLevel, model };
}

/**
 * 为一个 cwd 计算默认 session 目录。
 * 把 cwd 编码成 ~/.pi/agent/sessions/ 下的安全目录名。
 */
function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** 为同步 header 探测设上限，同时允许较大的 cwd 与自定义元数据字段。 */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		// 跳过格式错误的行
		return null;
	}
}

/** 为测试导出 */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	let pending = "";
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// 修复文件之前先校验 session header。
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	if (pending) appendFileSync(resolvedFilePath, "\n");
	return entries;
}

/**
 * 在搜索第一行已解析 session entry 时检查一个物理行。
 * 为匹配 loadEntriesFromFile() 的行为，空白和格式错误的行会被跳过。
 * 返回 undefined 表示继续扫描，null 表示解析出的是非 header entry，否则返回 header。
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		// 探测 EOF，让最后一行 header 在恰好在扫描上限处结束且不带换行时也被允许。
		// 多出任何一个字节都会超出有界扫描。
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		// 发现逻辑是尽力而为：不可读或超大的文件不是会话，
		// 且一个损坏的文件不能妨碍找到其他会话。
		return null;
	}
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** 为测试导出 */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(resolvedSessionDir, file))
			.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);

		for (const { path } of files) {
			const header = readSessionHeaderForDiscovery(path);
			if (header && (!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd))) return path;
		}
		return null;
	} catch {
		// 目录访问与 stat 竞态会让最近会话发现不可用。
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

async function buildSessionInfo(
	filePath: string,
	signal?: AbortSignal,
	fileStats?: Stats,
): Promise<SessionInfo | null> {
	try {
		const stats = fileStats ?? (await stat(filePath));
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let lastActivityTime: number | undefined;

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8", signal }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			// 提取会话名（取最新值，包括显式清除）
			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		signal?.throwIfAborted();
		return null;
	}
}

export type SessionListProgress = (
	loaded: number,
	total: number,
	/** 到目前为止已加载的会话，按活跃度排序。周期性更新时携带。 */
	partialSessions?: readonly SessionInfo[],
) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;
const MAX_CONCURRENT_SESSION_DISCOVERY_LOADS = 64;
const CURRENT_SESSION_LIST_PUBLISH_INTERVAL = 10;
const ALL_SESSION_LIST_PUBLISH_INTERVAL = 100;

interface SessionFileCandidate {
	path: string;
	stats?: Stats;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	map: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (nextIndex < items.length) {
			signal?.throwIfAborted();
			const index = nextIndex++;
			results[index] = await map(items[index]!, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

function sortSessionInfos(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function buildSessionInfosWithConcurrency(
	files: SessionFileCandidate[],
	onLoaded: (info: SessionInfo | null, index: number) => void,
	signal?: AbortSignal,
): Promise<(SessionInfo | null)[]> {
	return mapWithConcurrency(
		files,
		MAX_CONCURRENT_SESSION_INFO_LOADS,
		async (file, index) => {
			const info = await buildSessionInfo(file.path, signal, file.stats);
			onLoaded(info, index);
			return info;
		},
		signal,
	);
}

async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	signal?.throwIfAborted();
	if (!existsSync(dir)) return [];

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries
			.filter((file) => file.endsWith(".jsonl"))
			.sort((a, b) => b.localeCompare(a))
			.map((file) => ({ path: join(dir, file) }));
		const total = files.length;
		const partialSessions: SessionInfo[] = [];
		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(
			files,
			(info) => {
				loaded++;
				if (info) partialSessions.push(info);
				const publishPartial =
					loaded === 1 || loaded % CURRENT_SESSION_LIST_PUBLISH_INTERVAL === 0 || loaded === files.length;
				onProgress?.(loaded, total, publishPartial ? sortSessionInfos([...partialSessions]) : undefined);
			},
			signal,
		);
		return results.filter((info): info is SessionInfo => info !== null);
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

/**
 * 把对话会话管理为存储在 JSONL 文件中的追加式树。
 *
 * 每个 session entry 有 id 和 parentId，构成树形结构。"leaf"
 * 指针跟踪当前位置。追加会在当前 leaf 下创建子节点。
 * 分支把 leaf 移到更早的 entry，从而在不修改历史的情况下创建新分支。
 *
 * 用 buildSessionContext() 获取给 LLM 的已解析消息列表——它会
 * 处理 compaction summary，并沿 root 到当前 leaf 的路径行进。
 */
export class SessionManager {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}

		if (sessionFile) {
			this._setSessionFile(sessionFile, preloadedFileEntries);
		} else if (preloadedFileEntries?.length) {
			this._loadEntries(preloadedFileEntries, newSessionOptions);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	/** 切换到另一个 session 文件（用于 resume 和分支） */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	private _setSessionFile(sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			const entries = preloadedFileEntries ?? loadEntriesFromFile(this.sessionFile);

			// 若文件为空，用一个合法的 session header 初始化它。
			// 若文件非空但解析不出 pi 会话，则失败且不修改它。
			if (entries.length === 0) {
				const explicitPath = this.sessionFile;
				if (statSync(explicitPath).size > 0) {
					throw new Error(`Session file is not a valid ${APP_NAME} session: ${explicitPath}`);
				}
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			this._loadEntries(entries);
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // 保留 --session 标志给出的显式路径
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		return this.sessionFile;
	}

	private _loadEntries(entries: FileEntry[], options?: NewSessionOptions): void {
		const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;

		if (header) {
			this.fileEntries = entries;
			this.sessionId = header.id;

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}
		} else {
			this.newSession(options);
			this.fileEntries = this.fileEntries.concat(entries);
		}

		this._buildIndex();
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		const fd = openSync(this.sessionFile, "w");
		try {
			for (const entry of this.fileEntries) {
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			}
		} finally {
			closeSync(fd);
		}
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	/**
	 * 会话中包含 user 或 assistant 消息时才创建新的 session 文件。
	 * 仅设置项 entries（model、thinking level、system prompt）留在内存中，
	 * 这样打开又关闭 pi 而未聊天时不会留下文件。从 user 消息（而非
	 * 第一条 assistant 回复）开始，首次 turn 未完成时 prompt 也会保留在磁盘上（#10000）。
	 */
	private _hasConversation(): boolean {
		return this.fileEntries.some(
			(e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
		);
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		if (!this.flushed) {
			if (!this._hasConversation()) return;
			const fd = openSync(this.sessionFile, "wx");
			try {
				for (const e of this.fileEntries) {
					writeFileSync(fd, `${JSON.stringify(e)}\n`);
				}
			} finally {
				closeSync(fd);
			}
			this.flushed = true;
		} else {
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		}
	}

	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this._persist(entry);
	}

	/** 把一条消息追加为当前 leaf 的子节点，然后前移 leaf。返回 entry id。
	 * 不允许直接写入 CompactionSummaryMessage 和 BranchSummaryMessage。
	 * 原因：我们希望它们是会话中的顶层 entry，而不是消息型 session entry，
	 * 这样更容易找到它们。
	 * 它们需要通过 appendCompaction() 和 appendBranchSummary() 方法追加。
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 把一次 thinking level 变更追加为当前 leaf 的子节点，然后前移 leaf。返回 entry id。 */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 把一次 model 变更追加为当前 leaf 的子节点，然后前移 leaf。返回 entry id。 */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加不参与 LLM context 的、归因于 model 的 usage。返回追加的 entry。 */
	appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): UsageEntry {
		const entry: UsageEntry = {
			type: "usage",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			kind,
			provider,
			model,
			usage,
			...(note ? { note } : {}),
		};
		this._appendEntry(entry);
		return entry;
	}

	/** 把一条 compaction summary 追加为当前 leaf 的子节点，然后前移 leaf。返回 entry id。 */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		const timestamp = new Date().toISOString();
		const systemMessage = getCurrentSystemMessage(this.buildSessionProjection().messages);
		const id = generateId(this.byId);
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id,
			parentId: this.leafId,
			timestamp,
			summary,
			firstKeptEntryId: firstKeptEntryId ?? id,
			tokensBefore,
			details,
			usage,
			fromHook,
			...(systemMessage ? { systemMessage: { ...systemMessage, timestamp: new Date(timestamp).getTime() } } : {}),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 把一个 custom entry（供 extension 使用）追加为当前 leaf 的子节点，然后前移 leaf。返回 entry id。 */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加一个 session info entry（如显示名）。返回 entry id。 */
	appendSessionInfo(name: string): string {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 从最近的 session_info entry 取当前会话名（如有）。 */
	getSessionName(): string | undefined {
		// 从后向前遍历 entries 寻找最近的 session_info entry。
		// 空名称显式清除会话标题。直接读 fileEntries：footer
		// 每帧都会调用它，而 getEntries() 会复制整个会话。
		for (let i = this.fileEntries.length - 1; i >= 0; i--) {
			const entry = this.fileEntries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/**
	 * 追加一个参与 LLM context 的 custom message entry（供 extension 使用）。
	 * @param customType 用于重载时过滤的 extension 标识
	 * @param content 消息内容（字符串或 TextContent/ImageContent 数组）
	 * @param display 是否在 TUI 中显示（true = 样式化展示，false = 隐藏）
	 * @param details 可选的扩展专属元数据（不发送给 LLM）
	 * @returns 条目 ID
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 把对更早的模型可见 entry 的 branch 局部编辑追加为当前 leaf 的子节点。 */
	appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"]): string {
		if (
			replacement !== null &&
			(typeof replacement !== "object" ||
				!("content" in replacement) ||
				(typeof replacement.content !== "string" && !Array.isArray(replacement.content)))
		) {
			throw new Error("Context edit replacement must be null or contain string/array content");
		}
		const target = this.byId.get(targetId);
		if (!target) throw new Error(`Entry ${targetId} not found`);
		if (!this.getBranch().some((entry) => entry.id === targetId)) {
			throw new Error(`Entry ${targetId} is not on the active branch`);
		}
		const editable =
			target.type === "custom_message" ||
			(target.type === "message" &&
				(target.message.role === "user" ||
					target.message.role === "assistant" ||
					target.message.role === "toolResult"));
		if (!editable) throw new Error(`Entry ${targetId} does not contribute editable model content`);
		const targetRole = target.type === "message" ? target.message.role : "custom";
		const normalizedReplacement =
			replacement !== null &&
			(targetRole === "assistant" || targetRole === "toolResult") &&
			typeof replacement.content === "string"
				? { content: [{ type: "text" as const, text: replacement.content }] }
				: replacement;
		const entry: ContextEditEntry = {
			type: "context_edit",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			replacement: normalizedReplacement,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// 树遍历
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/**
	 * 获取一个 entry 的所有直接子节点。
	 */
	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * 获取 entry 的 label（如有）。
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * 设置或清除 entry 上的 label。
	 * label 是用户定义的、用于书签/导航的标记。
	 * 传 undefined 或空字符串清除 label。
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * 从 entry 走到 root，按路径顺序返回所有 entries。
	 * 包含所有 entry 类型（messages、compaction、model changes 等）。
	 * 要获取给 LLM 的已解析消息，用 buildSessionContext()。
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	/**
	 * 构建用于 context/渲染的活跃、感知 compaction 的 entry 列表。
	 * 从当前 leaf 开始树遍历。
	 */
	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * 构建 session context（会发送给 LLM 的内容）。
	 * 从当前 leaf 开始树遍历。
	 */
	buildSessionProjection(): SessionProjection {
		return buildSessionProjection(this.getEntries(), this.leafId, this.byId);
	}

	buildSessionContext(): SessionContext {
		const { messages, thinkingLevel, model } = this.buildSessionProjection();
		return { messages, thinkingLevel, model };
	}

	/**
	 * 获取 session header。
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/** session entry 的数量（不含 header），不像 `getEntries()` 那样复制。 */
	getEntryCount(): number {
		return this.byId.size;
	}

	/**
	 * 获取所有 session entries（不含 header）。返回浅拷贝。
	 * 会话是追加式的：用 appendXXX() 添加 entry，用 branch() 改变
	 * leaf 指针。entry 不能被修改或删除。
	 */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	/**
	 * 以树形结构获取会话。返回所有 entries 的浅层防御性拷贝。
	 * 良构的会话恰有一个 root（第一个 parentId === null 的 entry）。
	 * 孤儿 entry（父链中断）也会作为 root 返回。
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// 创建带已解析 label 的节点
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// 构建树
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// 孤立节点：将其视为根节点。
					roots.push(node);
				}
			}
		}

		// 按时间戳对 children 排序（旧的在前，新的在底部）
		// 用迭代方式避免深树导致栈溢出
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// 分支
	// =========================================================================

	/**
	 * 从更早的 entry 开始一个新分支。
	 * 把 leaf 指针移到该 entry。下一次 appendXXX() 调用
	 * 会创建它的子节点，形成新分支。现有 entries
	 * 不会被修改或删除。
	 */
	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/**
	 * 把 leaf 指针重置为 null（回到所有 entries 之前）。
	 * 下一次 appendXXX() 调用会创建新的 root entry（parentId = null）。
	 * 导航回去重新编辑第一条 user 消息时用它。
	 */
	resetLeaf(): void {
		this.leafId = null;
	}

	/**
	 * 以被放弃路径的摘要开始一个新分支。
	 * 与 branch() 相同，但还会追加一个 branch_summary entry，
	 * 记录被放弃对话路径的上下文。
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		const fromId = this.leafId ?? "root";
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId,
			summary,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * 创建一个新 session 文件，只含从 root 到指定 leaf 的路径。
	 * 适合从分支过的会话中抽取单条对话路径。
	 * 返回新的 session 文件路径，不持久化时为 undefined。
	 */
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// 从路径中过滤掉 LabelEntry——稍后会依据已解析的 map 重建它们。
		// 由于 label 是真实的树形 entry，后续 entry 可能是 label 的子节点；
		// 移除 label 需要重新串联保留路径，避免出现孤儿子树。
		const pathWithoutLabels: SessionEntry[] = [];
		const replacementByLabelId = new Map<string, string>();
		const pendingLabelIds: string[] = [];
		let pathParentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") {
				pendingLabelIds.push(entry.id);
				continue;
			}
			for (const labelId of pendingLabelIds) {
				replacementByLabelId.set(labelId, entry.id);
			}
			pendingLabelIds.length = 0;
			pathWithoutLabels.push(
				entry.type === "compaction"
					? {
							...entry,
							parentId: pathParentId,
							firstKeptEntryId:
								entry.firstKeptEntryId === entry.id
									? entry.id
									: (replacementByLabelId.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId),
						}
					: { ...entry, parentId: pathParentId },
			);
			pathParentId = entry.id;
		}

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// 收集路径中各 entry 的 label
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// 构建 label entries
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// 与 _persist() 用同一规则：分支路径已有对话就立即写入，
			// 否则稍后由 _persist() 创建文件。
			if (this._hasConversation()) {
				this._rewriteFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}

			return newSessionFile;
		}

		// 内存模式：用路径 + label 替换当前会话
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	/**
	 * 创建新会话。
	 * @param cwd 工作目录（存入 session header）
	 * @param sessionDir 可选 session 目录。省略时使用默认（~/.pi/agent/sessions/<encoded-cwd>/）。
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/**
	 * 打开指定的 session 文件。
	 * @param path session 文件路径
	 * @param sessionDir 可选 session 目录，用于 /new 或 /branch。省略时从文件的父目录推导。
	 * @param cwdOverride 可选的 cwd 覆盖，代替 session header 中的 cwd。
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;
		if (cwdOverride === undefined && existsSync(resolvedPath)) {
			try {
				header = readSessionHeader(resolvedPath);
			} catch (error) {
				if (!(error instanceof SessionHeaderScanLimitError)) throw error;
				// 有界扫描仅用于优化发现过程。对于头部或前缀特别大的旧文件，仍以完整加载结果为准。
				preloadedFileEntries = loadEntriesFromFile(resolvedPath);
				const firstEntry = preloadedFileEntries[0];
				header = firstEntry?.type === "session" ? firstEntry : null;
			}
		}
		const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
		// 未提供 sessionDir 时，从文件所在的父目录推导会话目录。
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, preloadedFileEntries);
	}

	/**
	 * 继续最近的会话；如果没有会话，则创建一个新会话。
	 * @param cwd 工作目录
	 * @param sessionDir 可选的会话目录。省略时使用默认目录（~/.pi/agent/sessions/<encoded-cwd>/）。
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** 创建仅驻留内存、不写入文件的会话；也可使用文件系统之外保存的条目初始化。 */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options, entries);
	}

	/**
	 * 将另一个项目目录中的会话分叉到当前项目。
	 * 在目标工作目录中创建新会话，并完整保留源会话的历史记录。
	 * @param sourcePath 源会话文件的路径
	 * @param targetCwd 目标工作目录（新会话的保存位置）
	 * @param sessionDir 可选的会话目录。省略时使用 targetCwd 对应的默认目录。
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// 创建新的会话文件，使用新 ID 并复制分叉会话的内容。
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// 写入新头部，将源会话设为父会话，并更新工作目录。
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		writeFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`, { flag: "wx" });

		// 复制源会话中除头部以外的所有条目。
		for (const entry of sourceEntries) {
			if (entry.type !== "session") {
				appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
			}
		}

		return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
	}

	/**
	 * 查找完全匹配的会话 ID，而不加载对话记录正文。
	 * @param cwd 工作目录（用于计算默认会话目录）
	 * @param id 完整会话 ID
	 * @param sessionDir 可选的会话目录。省略时使用默认目录（~/.pi/agent/sessions/<encoded-cwd>/）。
	 */
	static findById(cwd: string, id: string, sessionDir?: string): string | undefined {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const resolvedCwd = resolvePath(cwd);

		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".jsonl")) continue;
				const path = join(dir, file);
				const header = readSessionHeaderForDiscovery(path);
				if (header?.id !== id) continue;
				if (filterCwd && !sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd)) continue;
				return path;
			}
		} catch {
			// 精确查找会话尽力而为，与 list() 的行为一致。
		}
		return undefined;
	}

	/**
	 * 列出指定目录的所有会话。
	 * @param cwd 工作目录，用于计算默认会话目录。
	 * @param sessionDir 可选的会话目录。省略时使用默认目录（~/.pi/agent/sessions/<encoded-cwd>/）。
	 * @param onProgress 可选的进度回调，参数为已加载数量和总数。
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const resolvedCwd = resolvePath(cwd);
		const includeSession = (session: SessionInfo) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd);
		const progress: SessionListProgress | undefined = onProgress
			? (loaded, total, partialSessions) => onProgress(loaded, total, partialSessions?.filter(includeSession))
			: undefined;
		const sessions = (await listSessionsFromDir(dir, progress, signal)).filter(includeSession);
		return sortSessionInfos(sessions);
	}

	/**
	 * 列出所有项目目录中的全部会话。
	 * @param onProgress 可选的进度回调，参数为已加载数量和总数。
	 */
	static async listAll(onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;
	static async listAll(
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgressOrSignal?: SessionListProgress | AbortSignal,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
		const progress =
			typeof sessionDirOrOnProgress === "function"
				? sessionDirOrOnProgress
				: typeof onProgressOrSignal === "function"
					? onProgressOrSignal
					: undefined;
		const abortSignal =
			typeof sessionDirOrOnProgress === "string" || typeof onProgressOrSignal === "function"
				? signal
				: (onProgressOrSignal ?? signal);
		abortSignal?.throwIfAborted();
		if (customSessionDir) {
			return sortSessionInfos(await listSessionsFromDir(customSessionDir, progress, abortSignal));
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) return [];
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const dirs = entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(sessionsDir, entry.name));

			const dirFiles = await mapWithConcurrency(
				dirs,
				MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
				async (dir) => {
					try {
						return (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
					} catch {
						return [];
					}
				},
				abortSignal,
			);
			const allFiles = dirFiles.flat();
			const candidates = await mapWithConcurrency(
				allFiles,
				MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
				async (path): Promise<SessionFileCandidate> => {
					try {
						return { path, stats: await stat(path) };
					} catch {
						return { path };
					}
				},
				abortSignal,
			);
			candidates.sort(
				(a, b) =>
					(b.stats?.mtimeMs ?? Number.NEGATIVE_INFINITY) - (a.stats?.mtimeMs ?? Number.NEGATIVE_INFINITY) ||
					basename(b.path).localeCompare(basename(a.path)),
			);

			const totalFiles = candidates.length;
			let loaded = 0;
			let firstCandidateLoaded = false;
			const partialSessions: SessionInfo[] = [];
			const results = await buildSessionInfosWithConcurrency(
				candidates,
				(info, index) => {
					loaded++;
					if (index === 0) firstCandidateLoaded = true;
					if (info) partialSessions.push(info);
					const publishPartial =
						firstCandidateLoaded &&
						(index === 0 || loaded % ALL_SESSION_LIST_PUBLISH_INTERVAL === 0 || loaded === totalFiles);
					progress?.(loaded, totalFiles, publishPartial ? sortSessionInfos([...partialSessions]) : undefined);
				},
				abortSignal,
			);

			return sortSessionInfos(results.filter((info): info is SessionInfo => info !== null));
		} catch {
			abortSignal?.throwIfAborted();
			return [];
		}
	}
}
