/**
 * pi 与 pi.dev 共用的模型目录协议。
 *
 * 此文件会原样复制到两个代码库。修改时应在同一组拉取请求中更新两份副本，
 * 并确保两者逐字节保持一致：
 *
 *   earendil-works/pi      scripts/model-catalog-protocol.ts
 *   earendil-works/pi.dev  src/shared/models/protocol.ts
 *
 * pi 使用此文件发布目录修订版本，并根据 pi.dev 的目录选择逻辑测试客户端；pi.dev 使用它处理目录请求。
 * 此文件不得依赖导入或特定运行时 API，以便在 Node.js 和 Cloudflare Workers 中无需修改即可运行。
 *
 * `MODEL_CATALOG_PREFIX` 下的存储结构：
 *
 *   index.json                                    修订版本索引（`ModelCatalogIndex`）
 *   revisions/<revision>/models.json              按提供商和 ID 存储的聊天模型
 *   revisions/<revision>/models.all.json          按提供商存储的所有类型模型
 *   revisions/<revision>/providers.json           排序后的提供商 ID
 *   revisions/<revision>/providers/<id>.json      某个提供商按 ID 存储的聊天模型
 *   revisions/<revision>/providers/<id>.all.json  某个提供商的所有类型模型
 *
 * 发送 `?types=` 的客户端会收到带类型信息的 `.all.json` 版本；旧版客户端会收到仅包含聊天模型的兼容版本。
 */

export const MODEL_CATALOG_SCHEMA_VERSION = 1;
export const MODEL_CATALOG_PREFIX = `models/v${MODEL_CATALOG_SCHEMA_VERSION}`;
export const MODEL_CATALOG_INDEX_KEY = `${MODEL_CATALOG_PREFIX}/index.json`;
export const MODEL_CATALOG_REVISION_RE = /^sha256-[0-9a-f]{64}$/;

const PI_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PI_USER_AGENT_RE = /^pi\/([^\s()]+)(?: \([^;()]+(?:;\s*[^;()]+(?:;\s*[^()]+)?)?\))?$/i;
const MODEL_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type ParsedPiVersion = readonly [major: number, minor: number, patch: number, prerelease: string];

export type ModelCatalogArtifact = "models.json" | "models.all.json" | "providers.json";

export type ModelCatalogRepresentation = "legacy" | "typed";

export type ModelCatalogIndexEntry = {
	minimumPiVersion: string;
	revision: string;
};

export type ModelCatalogIndex = {
	schemaVersion: number;
	defaultRevision: string;
	catalogs: ModelCatalogIndexEntry[];
};

export type ModelCatalogRequest =
	| { kind: "catalog"; piVersion: string | undefined; representation: ModelCatalogRepresentation }
	| { kind: "redirect"; location: string }
	| { kind: "invalid"; error: string };

export function getModelCatalogArtifactKey(revision: string, artifact: ModelCatalogArtifact): string {
	return `${MODEL_CATALOG_PREFIX}/revisions/${revision}/${artifact}`;
}

export function getModelCatalogProviderKey(
	revision: string,
	provider: string,
	representation: ModelCatalogRepresentation,
): string {
	const suffix = representation === "typed" ? ".all.json" : ".json";
	return `${MODEL_CATALOG_PREFIX}/revisions/${revision}/providers/${provider}${suffix}`;
}

export function isValidModelCatalogPiVersion(version: string): boolean {
	return parsePiVersion(version) !== undefined;
}

/** 按语义化版本优先级比较两个 Pi 版本；版本无效时抛出异常。 */
export function compareModelCatalogPiVersions(left: string, right: string): number {
	return comparePiVersions(requirePiVersion(left), requirePiVersion(right));
}

/**
 * 解析 `types` 查询参数。参数存在但无效时返回 undefined。
 * 不发送该参数的客户端早于模型类型功能。
 */
export function parseModelCatalogRepresentation(
	types: string | null | undefined,
): ModelCatalogRepresentation | undefined {
	if (types === undefined || types === null) {
		return "legacy";
	}
	if (types === "" || types.split(",").some((type) => !MODEL_TYPE_RE.test(type))) {
		return undefined;
	}
	return "typed";
}

/**
 * 根据 URL 和 User-Agent 确定如何响应模型目录请求。
 *
 * 已发布的客户端不会发送 `pi-version`。响应按 URL 缓存，因此对于能识别为 Pi 的客户端，
 * 不根据 User-Agent 返回不同响应，而是将其重定向到带有明确 `pi-version` 的等效 URL。
 * 未携带 Pi User-Agent 的请求会收到默认目录。
 */
export function parseModelCatalogRequest(url: string | URL, userAgent: string | null | undefined): ModelCatalogRequest {
	const requestUrl = new URL(url);
	const representation = parseModelCatalogRepresentation(requestUrl.searchParams.get("types"));
	if (representation === undefined) {
		return { kind: "invalid", error: "Invalid model types." };
	}

	const piVersion = requestUrl.searchParams.get("pi-version");
	if (piVersion === null) {
		const userAgentVersion = PI_USER_AGENT_RE.exec(userAgent ?? "")?.[1];
		if (userAgentVersion !== undefined && isValidModelCatalogPiVersion(userAgentVersion)) {
			requestUrl.searchParams.set("pi-version", userAgentVersion);
			return { kind: "redirect", location: requestUrl.toString() };
		}
		return { kind: "catalog", piVersion: undefined, representation };
	}
	if (!isValidModelCatalogPiVersion(piVersion)) {
		return { kind: "invalid", error: "Invalid Pi version." };
	}
	return { kind: "catalog", piVersion, representation };
}

/**
 * 为指定的 Pi 版本选择目录修订版本：选择最低适用版本不高于该版本且数值最高的条目。
 * 未指定版本的请求使用默认修订版本；没有兼容条目时返回 undefined。
 */
export function selectModelCatalog(
	index: ModelCatalogIndex,
	piVersion: string | undefined,
): ModelCatalogIndexEntry | undefined {
	if (piVersion === undefined) {
		return index.catalogs.find((catalog) => catalog.revision === index.defaultRevision);
	}

	const requestedVersion = parsePiVersion(piVersion);
	if (!requestedVersion) {
		return undefined;
	}

	let selected: ModelCatalogIndexEntry | undefined;
	let selectedVersion: ParsedPiVersion | undefined;
	for (const catalog of index.catalogs) {
		const minimumVersion = requirePiVersion(catalog.minimumPiVersion);
		if (
			comparePiVersions(minimumVersion, requestedVersion) <= 0 &&
			(!selectedVersion || comparePiVersions(minimumVersion, selectedVersion) > 0)
		) {
			selected = catalog;
			selectedVersion = minimumVersion;
		}
	}
	return selected;
}

/**
 * 校验从存储中读取的索引。仅返回协议定义的字段；发布方可以在每个条目中存储额外元数据。
 */
export function parseModelCatalogIndex(value: unknown): ModelCatalogIndex {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION ||
		!("defaultRevision" in value) ||
		typeof value.defaultRevision !== "string" ||
		!MODEL_CATALOG_REVISION_RE.test(value.defaultRevision) ||
		!("catalogs" in value) ||
		!Array.isArray(value.catalogs) ||
		value.catalogs.length === 0 ||
		value.catalogs.some(
			(catalog) =>
				typeof catalog !== "object" ||
				catalog === null ||
				typeof catalog.minimumPiVersion !== "string" ||
				!parsePiVersion(catalog.minimumPiVersion) ||
				typeof catalog.revision !== "string" ||
				!MODEL_CATALOG_REVISION_RE.test(catalog.revision),
		) ||
		!value.catalogs.some((catalog) => catalog.revision === value.defaultRevision)
	) {
		throw new Error(`Model catalog index is invalid: ${MODEL_CATALOG_INDEX_KEY}`);
	}

	return {
		schemaVersion: value.schemaVersion,
		defaultRevision: value.defaultRevision,
		catalogs: value.catalogs.map(({ minimumPiVersion, revision }) => ({
			minimumPiVersion,
			revision,
		})),
	};
}

function requirePiVersion(version: string): ParsedPiVersion {
	const parsed = parsePiVersion(version);
	if (!parsed) {
		throw new Error(`Invalid Pi version: ${version}`);
	}
	return parsed;
}

function parsePiVersion(version: string): ParsedPiVersion | undefined {
	const match = PI_VERSION_RE.exec(version.trim());
	if (!match) {
		return undefined;
	}
	const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
	if (parsed.some((part) => !Number.isSafeInteger(part))) {
		return undefined;
	}
	return [parsed[0], parsed[1], parsed[2], match[4] ?? ""];
}

function comparePiVersions(left: ParsedPiVersion, right: ParsedPiVersion): number {
	for (const index of [0, 1, 2] as const) {
		const difference = left[index] - right[index];
		if (difference !== 0) {
			return difference;
		}
	}

	const leftPrerelease = left[3];
	const rightPrerelease = right[3];
	if (leftPrerelease === rightPrerelease) {
		return 0;
	}
	if (!leftPrerelease) {
		return 1;
	}
	if (!rightPrerelease) {
		return -1;
	}

	const leftParts = leftPrerelease.split(".");
	const rightParts = rightPrerelease.split(".");
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const leftPart = leftParts[index];
		const rightPart = rightParts[index];
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		if (leftPart === rightPart) continue;

		const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
		const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
		if (leftNumber !== undefined && rightNumber !== undefined) {
			return leftNumber - rightNumber;
		}
		if (leftNumber !== undefined) return -1;
		if (rightNumber !== undefined) return 1;
		return leftPart.localeCompare(rightPart);
	}
	return 0;
}
