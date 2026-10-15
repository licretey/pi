import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import { idFromNumber } from "./ids.ts";
import type {
	CheckpointInfo,
	CommonDocDefinition,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	DocDefinition,
	DocFamilyDefinition,
	DocFamilyToken,
	DocToken,
	DocumentAddress,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	DocumentSemantics,
	Id,
	JsonObject,
	LatestConversationSemantics,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	RewindableConversationSemantics,
	SessionDocFamilyToken,
	SessionDocToken,
	StoredDocument,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
} from "./types.ts";

type FamilyInput<T extends JsonObject, I extends JsonValue> = Omit<CommonDocDefinition<T>, "initial"> & {
	readonly family: true;
	initial(seed: I): T;
};

/** 定义一个会话（Session）作用域的单例文档。 */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & { readonly scope: "session" },
): SessionDocToken<T>;
/** 定义一个仅保留最新版本的对话单例文档。 */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & LatestConversationSemantics,
): ConversationDocToken<T>;
/** 定义一个可回退的对话单例文档。 */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & RewindableConversationSemantics,
): RewindableConversationDocToken<T>;
/** 定义一个任务作用域的单例文档。 */
export function defineDoc<T extends JsonObject>(
	definition: CommonDocDefinition<T> & { readonly scope: "task" },
): TaskDocToken<T>;
export function defineDoc<T extends JsonObject>(definition: DocDefinition<T>): DocToken<T, DocDefinition<T>> {
	validateDefinition(definition);
	return { definition };
}

/** 定义一个会话（Session）作用域的文档族。 */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & { readonly scope: "session" },
): SessionDocFamilyToken<T, I>;
/** 定义一个仅保留最新版本的对话文档族。 */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & LatestConversationSemantics,
): ConversationDocFamilyToken<T, I>;
/** 定义一个可回退的对话文档族。 */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & RewindableConversationSemantics,
): RewindableConversationDocFamilyToken<T, I>;
/** 定义一个任务作用域的文档族。 */
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: FamilyInput<T, I> & { readonly scope: "task" },
): TaskDocFamilyToken<T, I>;
export function defineDocFamily<T extends JsonObject, I extends JsonValue>(
	definition: DocFamilyDefinition<T, I>,
): DocFamilyToken<T, I, DocFamilyDefinition<T, I>> {
	validateDefinition(definition);
	return { definition };
}

/** 重载解析后由会话使用的、类型已被擦除的定义形态。 */
export type AnyDocDefinition = DocumentSemantics & {
	readonly kind: string;
	readonly version: number;
	readonly family?: true;
	initial(seed?: JsonValue): JsonObject;
	migrate?(value: JsonObject, fromVersion: number): JsonObject;
	checkpointWhen?(value: Readonly<JsonObject>, ops: readonly Op[], info: CheckpointInfo): boolean;
};

/** 类型已擦除的单例或文档族令牌。 */
export type AnyDocToken = { readonly definition: AnyDocDefinition };

function validateDefinition(definition: AnyDocDefinition): void {
	if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
		throw new TypeError(`Document ${definition.kind} version must be a positive integer`);
	}
}

/** 逻辑地址及其用于映射的字符串身份。 */
export type ResolvedAddress = {
	readonly address: DocumentAddress;
	readonly id: string;
	readonly nextArgument: number;
};

/** 解析重载的参数列表，返回指向 owner 与族键之后位置的索引。 */
export function resolveAddress(definition: AnyDocDefinition, args: readonly unknown[]): ResolvedAddress {
	let index = 0;
	let scope: DocumentAddress["scope"];
	switch (definition.scope) {
		case "session":
			scope = { kind: "session" };
			break;
		case "conversation":
			scope = { kind: "conversation", conversationId: ownerId<ConversationId>(args[index++], definition) };
			break;
		case "task":
			scope = { kind: "task", taskId: ownerId<TaskId>(args[index++], definition) };
			break;
	}
	const key = definition.family === true ? (args[index++] as string) : undefined;
	const address: DocumentAddress =
		key === undefined ? { kind: definition.kind, scope } : { kind: definition.kind, scope, key };
	return { address, id: addressId(address), nextArgument: index };
}

function ownerId<I extends Id<string>>(value: unknown, definition: AnyDocDefinition): I {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new TypeError(`Document ${definition.kind} requires a ${definition.scope} ID`);
	}
	return idFromNumber<I>(value);
}

/** 单个逻辑地址的稳定字符串身份。 */
export function addressId(address: DocumentAddress): string {
	const owner =
		address.scope.kind === "session"
			? null
			: address.scope.kind === "conversation"
				? address.scope.conversationId
				: address.scope.taskId;
	return JSON.stringify([address.kind, address.scope.kind, owner, address.key ?? null]);
}

/** 为某地址上新一次具现（incarnation）构建存储创建记录。 */
export function documentCreate(definition: AnyDocDefinition, address: DocumentAddress, id: DocumentId): DocumentCreate {
	const key = address.key === undefined ? {} : { key: address.key };
	switch (address.scope.kind) {
		case "session":
			return { id, kind: address.kind, ...key, scope: address.scope };
		case "task":
			return { id, kind: address.kind, ...key, scope: address.scope };
		case "conversation":
			return {
				id,
				kind: address.kind,
				...key,
				scope: address.scope,
				history: definition.history!,
				fork: definition.fork!,
			} as DocumentCreate;
	}
}

/** 当令牌与持久化的作用域、历史或分叉语义不一致时，拒绝该带类型的访问。 */
export function checkRecordScope(definition: AnyDocDefinition, record: DocumentCreate | DocumentRecord): void {
	if (
		record.scope.kind !== definition.scope ||
		(record.scope.kind === "conversation" &&
			(record.history !== definition.history || record.fork !== definition.fork))
	) {
		throw new TypeError(`Document ${record.id} (${record.kind}) does not match the supplied definition semantics`);
	}
}

/** 当存储版本超出所给定义的可用范围时，拒绝该带类型的访问。 */
export function checkRecordVersion(
	definition: AnyDocDefinition,
	record: DocumentCreate | DocumentRecord,
	version: number,
): void {
	if (version > definition.version) {
		throw new Error(`Document ${record.id} (${record.kind}) has newer version ${version} than ${definition.version}`);
	}
	if (version < definition.version && definition.migrate === undefined) {
		throw new Error(`Document ${record.id} (${record.kind}) requires migration from version ${version}`);
	}
}

/** 校验并具体化一个尚未挂接的存储值，供带类型的访问使用。 */
export function materializeDocument(definition: AnyDocDefinition, stored: StoredDocument): JsonObject {
	return materializeDocumentValue(definition, stored.record, stored.version, stored.value);
}

/** 在首次持久化具现之前，校验并具体化一个尚未挂接的值。 */
export function materializeDocumentValue(
	definition: AnyDocDefinition,
	record: DocumentCreate | DocumentRecord,
	version: number,
	value: JsonObject,
): JsonObject {
	checkRecordScope(definition, record);
	checkRecordVersion(definition, record, version);
	if (version === definition.version) return value;
	return copyJson(definition.migrate!(value, version)) as JsonObject;
}
