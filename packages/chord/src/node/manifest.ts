export const FACET_BUNDLE_FORMAT = "chord.facet-bundle";
export const FACET_BUNDLE_FORMAT_VERSION = 2;
export const FACET_BUNDLE_MANIFEST_FILE = "chord-facets.json";
export const FACET_BUNDLE_ARTIFACT_FORMAT = "chord.facet-bundle-artifact";
export const FACET_BUNDLE_ARTIFACT_FORMAT_VERSION = 2;

export interface FacetBundleEntry {
	/** 相对于清单的内容寻址 CommonJS 文件名。 */
	readonly file: string;
	/** JavaScript 文件的 SHA-256 子资源完整性校验值。 */
	readonly integrity: string;
	/** 有意留给加载方应用程序解析的导入项。 */
	readonly externalImports: readonly string[];
	/** 生成 source map 时，其相对于清单的文件名。 */
	readonly sourceMap?: string;
}

export interface FacetBundleManifest {
	readonly format: typeof FACET_BUNDLE_FORMAT;
	readonly formatVersion: typeof FACET_BUNDLE_FORMAT_VERSION;
	readonly plugin: FacetBundlePlugin;
	readonly entries: Readonly<Record<string, FacetBundleEntry>>;
}

export interface FacetBundlePlugin {
	readonly id: string;
	readonly version?: string;
}

/** 一个自包含的清单条目，可用于存储或传输到另一 Node 宿主。 */
export interface FacetBundleArtifact {
	readonly format: typeof FACET_BUNDLE_ARTIFACT_FORMAT;
	readonly formatVersion: typeof FACET_BUNDLE_ARTIFACT_FORMAT_VERSION;
	readonly plugin: FacetBundlePlugin;
	readonly entryName: string;
	readonly entry: FacetBundleEntry;
	readonly source: string;
	readonly sourceMapContents?: string;
}
