import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import {
	type AuthResolutionOverrides,
	ModelsError,
	refreshStoredOAuthCredential,
	resolveProviderAuth,
} from "./auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthOperationOptions,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	LoginOptions,
	ProviderAuth,
} from "./auth/types.ts";
import { InMemoryModelsStore, type ModelsStore, type ModelsStoreEntry } from "./models-store.ts";
import type {
	AnyModel,
	Api,
	ApiStreamOptions,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesOptions,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	ModelType,
	ModelTypeMap,
	ProviderClassifier,
	ProviderHeaders,
	ProviderImages,
	ProviderRequestOptions,
	ProviderStreams,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "./types.ts";
import { operationSignal, raceWithAbortSignal } from "./utils/abort.ts";
import {
	assertChatModel,
	assertClassifierInputSupported,
	assertClassifierModel,
	assertImageModel,
	classifierErrorResult,
	getModelType,
	imageErrorResult,
	isModelType,
} from "./utils/model-operations.ts";
import { normalizeContext } from "./utils/transcript.ts";

export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";
export { getModelType, isModelType } from "./utils/model-operations.ts";

export interface ModelsPublication {
	/** 由 provider 决定持久化的目录。省略则保持存储不变；null 表示删除。 */
	persist?: ModelsStoreEntry | null;
	/** 可选的对 provider 私有内存目录状态的同步更新。 */
	update?: () => void;
}

export interface RefreshModelsContext {
	/** 实际生效的已配置凭据。OAuth 凭据会在网络访问前刷新。 */
	credential?: Credential;
	/** 在本刷新阶段之前捕获的、按 provider 划分的不可变目录快照。 */
	stored?: Readonly<ModelsStoreEntry>;
	/**
	 * 带代数检查的发布。持久化策略仍由 provider 自持；
	 * 只有在选定的持久化变更完成后才会同步执行更新。
	 */
	publish(publication: ModelsPublication): Promise<boolean>;
	/** 离线/仅缓存初始化期间为 false。 */
	allowNetwork: boolean;
	/** 允许网络访问时跳过 provider 的新鲜度检查，立即拉取。 */
	force?: boolean;
	/** 始终存在，即使公开的 refresh 调用方省略了其可选 signal。 */
	signal: AbortSignal;
}

export interface ModelsRefreshOptions {
	allowNetwork?: boolean;
	/** 将刷新限定在这些 provider ID 内。未知和静态的 provider 会被忽略。 */
	providers?: readonly string[];
	/** 允许网络访问时跳过 provider 的新鲜度检查，立即拉取。 */
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsRefreshResult {
	aborted: boolean;
	errors: ReadonlyMap<string, Error>;
}

export interface ModelsRequestTransforms {
	/** 在分发给 provider 之前，对组装完成的模型/认证/请求头做变换。 */
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}

export type ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsRequestTransforms;
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsRequestTransforms;
export type ModelsDeferredFetchOptions = DeferredFetchOptions & ModelsRequestTransforms;
export type ModelsDeferredCancelOptions = DeferredCancelOptions & ModelsRequestTransforms;
export type ModelsImagesOptions = ImagesOptions & ModelsRequestTransforms;
export type ModelsClassifierOptions = ClassifierOptions & ModelsRequestTransforms;

const KNOWN_MODEL_TYPES: Record<ModelType, true> = { chat: true, image: true, classifier: true };

/** 存储和远程来源中的模型可能带有只有更新版本才认识的类型。 */
function hasKnownModelType(model: AnyModel): boolean {
	return Object.hasOwn(KNOWN_MODEL_TYPES, getModelType(model));
}

/** 丢弃本版本不认识的类型的已存储模型。 */
function withKnownModelTypes(entry: ModelsStoreEntry): ModelsStoreEntry {
	return { ...entry, models: entry.models.filter(hasKnownModelType) };
}

/** 具有聊天 API `TApi` 的 provider 能列出的任意模型。 */
type ProviderModel<TApi extends Api> = Model<TApi> | ImageModel<ImageApi> | ClassifierModel<ClassifierApi>;

/**
 * provider 是具体的运行时单元。它拥有 id/name/base 元数据、认证方法、
 * 模型列表，以及其模型支持的操作（流式、图像生成、分类）。
 *
 * `TApi` 让具体的 provider 工厂声明其模型使用哪些聊天 API（例如
 * `openaiProvider(): Provider<"openai-responses" | "openai-completions">`），
 * 为直接使用工厂的用户提供带类型的聊天模型列表。其他模型类型使用各自
 * 操作专属的 API 联合类型。在 `Models` 集合内部，provider 以
 * `Provider<Api>` 的形式持有。
 */
export interface Provider<TApi extends Api = Api> {
	readonly id: string;
	readonly name: string;

	readonly baseUrl?: string;
	readonly headers?: ProviderHeaders;

	/**
	 * 必填：`apiKey`/`oauth` 至少其一。每个 provider 都有认证语义——即使是
	 * 只有周边凭据（环境变量、AWS profile、ADC 文件）的 provider，以及无需
	 * 密钥的本地服务器，也会提供 `apiKey` 认证，其 `resolve()` 会报告该
	 * provider 是否已配置。当 provider 未配置时 `Models.getAuth()` 返回
	 * undefined。
	 */
	readonly auth: ProviderAuth;

	/**
	 * 当前已知的聊天模型，同步。静态 provider 返回其目录；动态 provider
	 * 返回最近一次 `refreshModels()` 时的列表（首次之前为空）。禁止抛出
	 * 异常；`Models` 会把抛异常的实现视为没有模型。
	 */
	getModels(): readonly Model<TApi>[];

	/**
	 * 当前已知的全部类型模型，同步，契约与 `getModels()` 相同。只有聊天
	 * 模型的 provider 可以省略；此时 `Models` 会使用 `getModels()`。模型 id
	 * 在每个类型内唯一；同一个上游模型可能因不同操作而有多个条目。
	 */
	getAllModels?(): readonly ProviderModel<TApi>[];

	/**
	 * 仅限动态 provider：恢复 `context.stored`，并可选地用生效凭据拉取更新的
	 * 列表。实现应在失败时保留上一次的列表，通过 `context.publish()` 发布
	 * 持久化与同步状态变更，并在阻塞工作中遵守共享的中止 signal。
	 */
	refreshModels?(context: RefreshModelsContext): Promise<void>;

	/**
	 * 可选的 provider 策略，用于按凭据判定模型可用性。`getModels()` 仍是
	 * 完整的同步聊天目录；`Models.getAvailable()` 会在确认 provider 认证
	 * 已配置后应用此过滤器。
	 */
	filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];

	/**
	 * 可选的跨全部模型类型的按凭据可用性策略。没有它时，
	 * `Models.getAllAvailable()` 会对聊天模型应用 `filterModels`，
	 * 并保留其余所有模型。
	 */
	filterAllModels?(
		models: readonly ProviderModel<TApi>[],
		credential: Credential | undefined,
	): readonly ProviderModel<TApi>[];

	/** 流式处理规范化后的转录。`Models` 在分发到这里之前会先规范化调用方的 `Context`。 */
	stream<T extends TApi>(
		model: Model<T>,
		context: TranscriptContext,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	streamSimple(
		model: Model<TApi>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<TApi>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(model: Model<TApi>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;

	/** 当 provider 支持专用图像模型时存在。从不 reject。 */
	generateImages?(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;

	/** 当 provider 支持结构化分类器模型时存在。从不 reject。 */
	classify?(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ClassifierOptions,
	): Promise<ClassifierResult>;
}

/**
 * 运行时的 provider 集合，外加认证应用与请求便捷方法。请求行为由 provider
 * 自持；`Models` 负责解析认证，并把每个请求委托给拥有该模型的 provider。
 *
 * 读取访问器有三种形式：不带后缀的（`getModels`、`getModel`、
 * `getAvailable`）返回聊天模型；`*OfType` 访问器返回单一模型类型；
 * `getAllModels`/`getAllAvailable` 返回全部类型。
 */
export interface Models {
	getProviders(): readonly Provider[];
	getProvider(id: string): Provider | undefined;

	/**
	 * 同步读取一个或全部 provider 最近已知的聊天模型。尽力而为：
	 * `getModels()` 抛异常的 provider 不会贡献任何模型。
	 */
	getModels(provider?: string): readonly Model<Api>[];

	/**
	 * 同步的运行时聊天模型查找，基于最近已知的列表。动态模型列表的类型是
	 * `Model<Api>`；用 `hasApi()` 类型守卫收窄。
	 */
	getModel(provider: string, id: string): Model<Api> | undefined;

	/** 同步读取一个或全部 provider 最近已知的单一类型模型。 */
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][];

	/** 同步的运行时查找，基于最近已知列表查找单一类型的模型。 */
	getModelOfType<TType extends ModelType>(type: TType, provider: string, id: string): ModelTypeMap[TType] | undefined;

	/** 同步读取一个或全部 provider 最近已知的全部类型模型。 */
	getAllModels(provider?: string): readonly AnyModel[];

	/**
	 * 并发刷新选定的已配置动态 provider（省略 `providers` 时为全部）。
	 * provider 错误与取消会作为结果返回而不 reject；静态、未知和未配置的
	 * provider 会被跳过。
	 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;

	/** 检查一个 provider 是否有完整的认证配置，但不刷新 OAuth。 */
	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined>;

	/** 返回其 provider 具有完整认证配置的聊天模型。 */
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]>;

	/** 返回其 provider 具有完整认证配置的单一类型模型。 */
	getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]>;

	/** 返回其 provider 具有完整认证配置的全部类型模型。 */
	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]>;

	/**
	 * 按 provider id 解析 provider 范围的认证；传入模型时还会附加上静态
	 * 模型请求头。结果带有用于状态 UI 的来源标签。当 provider 未知或未
	 * 配置时解析为 `undefined`。失败时以 `ModelsError` reject：token 刷新
	 * 失败时错误码为 "oauth"（已存储的凭据会保留以便重试；重新登录即可
	 * 修复），api-key 解析或凭据存储失败时错误码为 "auth"。请求路径会把
	 * 这种拒绝作为流错误暴露出来。
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/** 运行 provider 自有登录流程，并持久化其返回的凭据。 */
	login(providerId: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential>;

	/** 移除某个 provider 的已存储凭据。 */
	logout(providerId: string, options?: AuthOperationOptions): Promise<void>;

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream;
	fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage>;
	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void>;

	/**
	 * 通过拥有该模型的 provider 生成图像，认证解析方式与 `stream()` 相同。
	 * 从不 reject：未知 provider、未配置的认证以及没有 `generateImages`
	 * 的 provider 都会返回一个错误的 `AssistantImages`。
	 */
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages>;

	/** 通过拥有该模型的 provider 对结构化状态进行分类。从不 reject。 */
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult>;
}

export interface MutableModels extends Models {
	/** 按 provider.id 插入或替换。provider id 唯一。 */
	setProvider(provider: Provider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

export interface CreateModelsOptions {
	credentials?: CredentialStore;
	modelsStore?: ModelsStore;
	authContext?: AuthContext;
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private modelsStore: ModelsStore;
	private authContext: AuthContext;
	private refreshGenerations = new Map<string, number>();
	private refreshControllers = new Map<string, AbortController>();
	private publicationChains = new Map<string, Promise<unknown>>();

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: Provider): void {
		this.supersedeProviderRefresh(provider.id);
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.supersedeProviderRefresh(id);
		this.providers.delete(id);
	}

	clearProviders(): void {
		for (const id of new Set([...this.providers.keys(), ...this.refreshControllers.keys()])) {
			this.supersedeProviderRefresh(id);
		}
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: Model<Api>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// 尽力而为：行为异常的 provider 不贡献任何模型。
			}
		}
		return models;
	}

	getAllModels(provider?: string): readonly AnyModel[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getAllModels?.() ?? entry.getModels();
			} catch {
				return [];
			}
		}

		const models: AnyModel[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...(entry.getAllModels?.() ?? entry.getModels()));
			} catch {
				// 尽力而为：行为异常的 provider 不贡献任何模型。
			}
		}
		return models;
	}

	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.getAllModels(provider).filter((model): model is ModelTypeMap[TType] => isModelType(model, type));
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	getModelOfType<TType extends ModelType>(type: TType, provider: string, id: string): ModelTypeMap[TType] | undefined {
		return this.getModelsOfType(type, provider).find((model) => model.id === id);
	}

	private supersedeProviderRefresh(providerId: string): number {
		const generation = (this.refreshGenerations.get(providerId) ?? 0) + 1;
		this.refreshGenerations.set(providerId, generation);
		const previous = this.refreshControllers.get(providerId);
		if (previous) {
			this.refreshControllers.delete(providerId);
			previous.abort();
		}
		return generation;
	}

	private beginProviderRefresh(providerId: string): { generation: number; controller: AbortController } {
		const generation = this.supersedeProviderRefresh(providerId);
		const controller = new AbortController();
		this.refreshControllers.set(providerId, controller);
		return { generation, controller };
	}

	private publishProviderModels(
		providerId: string,
		generation: number,
		signal: AbortSignal,
		publication: ModelsPublication,
	): Promise<boolean> {
		const previous = this.publicationChains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous.catch(() => {});
			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;

			if (publication.persist === null) {
				await this.modelsStore.delete(providerId, { signal });
			} else if (publication.persist !== undefined) {
				await this.modelsStore.write(providerId, structuredClone(publication.persist), { signal });
			}

			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;
			publication.update?.();
			return true;
		})();
		const tail = queued.catch(() => {});
		this.publicationChains.set(providerId, tail);
		void tail.then(() => {
			if (this.publicationChains.get(providerId) === tail) this.publicationChains.delete(providerId);
		});
		return raceWithAbortSignal(queued, signal);
	}

	private async runProviderRefreshPhase(
		provider: Provider & Required<Pick<Provider, "refreshModels">>,
		credential: Credential | undefined,
		allowNetwork: boolean,
		force: boolean | undefined,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		const stored = await this.modelsStore.read(provider.id, { signal });
		await provider.refreshModels({
			credential,
			stored: stored ? withKnownModelTypes(structuredClone(stored)) : undefined,
			publish: (publication) => this.publishProviderModels(provider.id, generation, signal, publication),
			allowNetwork,
			force: allowNetwork ? force : undefined,
			signal,
		});
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? true;
		const callerSignal = operationSignal(options.signal);
		const errors = new Map<string, Error>();
		if (callerSignal.aborted) return { aborted: true, errors };
		const selected = options.providers ? new Set(options.providers) : undefined;
		const refreshable = Array.from(this.providers.values()).filter(
			(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
				provider.refreshModels !== undefined && (!selected || selected.has(provider.id)),
		);

		const refresh = Promise.all(
			refreshable.map(async (provider) => {
				const { generation, controller } = this.beginProviderRefresh(provider.id);
				const signal = AbortSignal.any([callerSignal, controller.signal]);
				const operation = (async () => {
					let storedCredential: Credential | undefined;
					let credentialError: unknown;
					try {
						storedCredential = await this.readCredential(provider.id, signal);
					} catch (error) {
						credentialError = error;
					}

					// 在认证解析和网络访问之前，先恢复缓存的 provider 状态。
					await this.runProviderRefreshPhase(provider, storedCredential, false, undefined, generation, signal);
					if (credentialError !== undefined) throw credentialError;
					if (!allowNetwork || signal.aborted) return;

					const credential = await this.resolveRefreshCredential(provider, storedCredential, signal);
					if (!credential) return;
					await this.runProviderRefreshPhase(provider, credential, true, options.force, generation, signal);
				})();

				try {
					await raceWithAbortSignal(operation, signal);
				} catch (error) {
					if (!signal.aborted) {
						errors.set(
							provider.id,
							error instanceof Error
								? error
								: new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }),
						);
					}
				} finally {
					if (this.refreshControllers.get(provider.id) === controller) {
						this.refreshControllers.delete(provider.id);
					}
				}
			}),
		);

		try {
			await raceWithAbortSignal(refresh, callerSignal);
		} catch (error) {
			if (!callerSignal.aborted) throw error;
		}

		return { aborted: callerSignal.aborted, errors: new Map(errors) };
	}

	private async resolveRefreshCredential(
		provider: Provider,
		stored: Credential | undefined,
		signal: AbortSignal,
	): Promise<Credential | undefined> {
		if (stored?.type === "oauth") {
			const oauth = provider.auth.oauth;
			if (!oauth) return undefined;
			if (Date.now() < stored.expires) return stored;
			if (signal.aborted) return undefined;
			// 已开始的刷新会存活到完成，不会被取消或被更新的模型刷新取代，
			// 因此轮换后的 refresh token 总会被持久化。之后更新的刷新就能
			// 看到新鲜的凭据。
			return refreshStoredOAuthCredential(
				this.credentials,
				provider.id,
				oauth,
				(current) => Date.now() >= current.expires,
				signal,
			);
		}

		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		const credential = stored?.type === "api_key" ? stored : undefined;
		const result = await apiKey.resolve({ ctx: this.authContext, credential, signal });
		if (!result) return undefined;
		return { type: "api_key", key: result.auth.apiKey, env: result.env };
	}

	private async readCredential(providerId: string, signal: AbortSignal): Promise<Credential | undefined> {
		try {
			return await this.credentials.read(providerId, { signal });
		} catch (error) {
			throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		}
	}

	private async checkProviderAuth(
		provider: Provider,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<AuthCheck | undefined> {
		if (credential?.type === "oauth") {
			return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		}
		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		if (apiKey.check) {
			try {
				return await apiKey.check({
					ctx: this.authContext,
					credential: credential?.type === "api_key" ? credential : undefined,
					signal,
				});
			} catch (error) {
				throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
			}
		}

		const resolution = await resolveProviderAuth(provider, this.credentials, this.authContext, { signal });
		return resolution ? { source: resolution.source, type: "api_key" } : undefined;
	}

	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		const signal = operationSignal(options?.signal);
		const check = (async () => {
			signal.throwIfAborted();
			const provider = this.providers.get(providerId);
			if (!provider) return undefined;
			return this.checkProviderAuth(provider, await this.readCredential(providerId, signal), signal);
		})();
		return raceWithAbortSignal(check, signal);
	}

	private async getAuthenticatedProviders(providerId: string | undefined, signal: AbortSignal) {
		signal.throwIfAborted();
		const providers = providerId
			? [this.providers.get(providerId)].filter((entry) => entry !== undefined)
			: this.getProviders();
		const checks = await Promise.all(
			providers.map(async (provider) => {
				const credential = await this.readCredential(provider.id, signal);
				return { provider, credential, auth: await this.checkProviderAuth(provider, credential, signal) };
			}),
		);
		return checks.filter((entry) => entry.auth !== undefined);
	}

	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		const signal = operationSignal(options?.signal);
		const available = (async () => {
			const providers = await this.getAuthenticatedProviders(providerId, signal);
			return providers.flatMap(({ provider, credential }) => {
				const models = provider.getModels();
				return provider.filterModels?.(models, credential) ?? models;
			});
		})();
		return raceWithAbortSignal(available, signal);
	}

	async getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return (await this.getAllAvailable(providerId, options)).filter((model): model is ModelTypeMap[TType] =>
			isModelType(model, type),
		);
	}

	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		const signal = operationSignal(options?.signal);
		const available = (async () => {
			const providers = await this.getAuthenticatedProviders(providerId, signal);
			return providers.flatMap(({ provider, credential }) => {
				const models = provider.getAllModels?.() ?? provider.getModels();
				if (provider.filterAllModels) return provider.filterAllModels(models, credential);
				if (!provider.filterModels) return models;
				const availableChatIds = new Set(
					provider.filterModels(provider.getModels(), credential).map((model) => model.id),
				);
				return models.filter((model) => !isModelType(model, "chat") || availableChatIds.has(model.id));
			});
		})();
		return raceWithAbortSignal(available, signal);
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const signal = operationSignal(overrides?.signal);
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, { ...overrides, signal });
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		return {
			...result,
			auth: {
				...result.auth,
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		};
	}

	async login(
		providerId: string,
		type: AuthType,
		interaction: AuthInteraction,
		options?: LoginOptions,
	): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		signal.throwIfAborted();
		const provider = this.providers.get(providerId);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (!method?.login) {
			throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
		}
		const loginOperation: Promise<Credential> = method.login({ ...interaction, signal }, options);
		const credential = await raceWithAbortSignal(loginOperation, signal);
		let mutationStarted = false;
		let markMutationStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markMutationStarted = resolve;
		});
		const mutation = this.credentials.modify(
			providerId,
			async () => {
				mutationStarted = true;
				markMutationStarted?.();
				return credential;
			},
			{ signal },
		);
		void mutation.catch(() => {});
		try {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					if (!mutationStarted) reject(signal.reason);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				void Promise.race([started, mutation]).then(
					() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					},
					(error: unknown) => {
						signal.removeEventListener("abort", onAbort);
						reject(error);
					},
				);
				if (signal.aborted) onAbort();
			});
			await mutation;
		} catch (error) {
			signal.throwIfAborted();
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		return credential;
	}

	async logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
		const signal = operationSignal(options?.signal);
		signal.throwIfAborted();
		try {
			await this.credentials.delete(providerId, { signal });
		} catch (error) {
			signal.throwIfAborted();
			throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
		}
	}

	private requireProvider(model: AnyModel): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	private requireChatProvider(model: Model<Api>): Provider {
		assertChatModel(model);
		return this.requireProvider(model);
	}

	private async applyAuth<
		TModel extends AnyModel,
		TOptions extends ProviderRequestOptions<TModel> & ModelsRequestTransforms,
	>(
		model: TModel,
		options: TOptions | undefined,
	): Promise<{
		requestModel: TModel;
		requestOptions: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions<TModel>;
	}> {
		this.requireProvider(model);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) {
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		const auth = resolution.auth;

		// 显式请求选项逐字段优先；Models 专属的变换最后执行。
		const apiKey = options?.apiKey ?? auth.apiKey;
		let headers = mergeHeaders(auth.headers, options?.headers);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestModel: TModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		const requestOptions = { ...providerOptions, apiKey, headers, env } as Omit<TOptions, "transformHeaders"> &
			ProviderRequestOptions<TModel>;

		return { requestModel, requestOptions };
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(model, async () => {
			const provider = this.requireChatProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(
				model,
				options as ModelsApiStreamOptions<Api> | undefined,
			);
			return provider.stream(requestModel, transcript, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const transcript = normalizeContext(context);
		return lazyStream(model, async () => {
			const provider = this.requireChatProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, transcript, requestOptions as SimpleStreamOptions);
		});
	}

	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireChatProvider(model);
			if (!provider.fetchDeferred) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
			}
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.fetchDeferred(requestModel, handle, requestOptions as DeferredFetchOptions);
		});
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const provider = this.requireChatProvider(model);
		if (!provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		const { requestModel, requestOptions } = await this.applyAuth(model, options);
		await provider.cancelDeferred(requestModel, handle, requestOptions);
	}

	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		try {
			assertImageModel(model);
			const provider = this.requireProvider(model);
			if (!provider.generateImages) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support image generation`);
			}
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return await provider.generateImages(requestModel, context, requestOptions);
		} catch (error) {
			return imageErrorResult(model, error, options?.signal?.aborted);
		}
	}

	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		try {
			assertClassifierModel(model);
			assertClassifierInputSupported(model, context);
			const provider = this.requireProvider(model);
			if (!provider.classify) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support classification`);
			}
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return await provider.classify(requestModel, context, requestOptions);
		} catch (error) {
			return classifierErrorResult(model, error, options?.signal?.aborted);
		}
	}
}

export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}

export interface CreateProviderOptions<TApi extends Api = Api> {
	id: string;
	/** 显示名称。默认为 `id`。 */
	name?: string;
	baseUrl?: string;
	headers?: ProviderHeaders;
	/** 必填——每个 provider 都有认证语义，即使是仅靠周边凭据或免密钥的也一样。 */
	auth: ProviderAuth;
	/**
	 * 全部类型的静态基线模型（纯动态 provider 为空）。
	 * 没有 `type` 字段的模型是聊天模型。
	 */
	models: readonly ProviderModel<TApi>[];
	/**
	 * 拉取全部类型的动态模型覆盖层。createProvider 会以事务方式恢复并
	 * 发布它，并丢弃未知类型的模型。
	 */
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly ProviderModel<TApi>[]>;
	/** 按凭据判定的聊天模型可用性。见 `Provider.filterModels`。 */
	filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
	/** 跨全部模型类型的按凭据可用性。见 `Provider.filterAllModels`。 */
	filterAllModels?: (
		models: readonly ProviderModel<TApi>[],
		credential: Credential | undefined,
	) => readonly ProviderModel<TApi>[];
	/**
	 * 聊天实现：所有聊天模型共用一个，或为混合 API 的 provider 提供
	 * 以 `model.api` 为键的映射。当给出 `images` 或 `classifiers` 时可选。
	 */
	api?: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
	/** 以 `model.api` 为键的图像生成实现。 */
	images?: Partial<Record<ImageApi, ProviderImages>>;
	/** 以 `model.api` 为键的分类器实现。 */
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
}

/**
 * 从各个部分组装出一个 provider。内置 provider 工厂和 models.json 自定义
 * provider 都经过这里。单一的 `api` 用于流式处理所有聊天模型；`api` 映射
 * 则按 `model.api` 分发，没有对应条目的 api 会产生流错误。一次性操作
 * 映射同样按 `model.api` 分发。`api`/`images`/`classifiers` 中至少要有
 * 一个具体实现；空映射会被拒绝。
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	const single =
		input.api && typeof (input.api as ProviderStreams).stream === "function"
			? (input.api as ProviderStreams)
			: undefined;
	const byApi = single || !input.api ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);
	const images = input.images as Partial<Record<string, ProviderImages>> | undefined;
	const classifiers = input.classifiers as Partial<Record<string, ProviderClassifier>> | undefined;
	const streams = single ? [single] : Object.values(byApi ?? {}).filter((entry) => entry !== undefined);
	const imageImplementations = Object.values(images ?? {}).filter((entry) => entry !== undefined);
	const classifierImplementations = Object.values(classifiers ?? {}).filter((entry) => entry !== undefined);
	if (streams.length === 0 && imageImplementations.length === 0 && classifierImplementations.length === 0) {
		throw new Error(`Provider ${input.id}: at least one of "api", "images", or "classifiers" is required.`);
	}

	const baselineModels = input.models;
	let dynamicModels: readonly ProviderModel<TApi>[] = [];
	const fetchModels = input.fetchModels;
	const currentModels = (): readonly ProviderModel<TApi>[] => {
		const merged = [...baselineModels];
		for (const model of dynamicModels) {
			const index = merged.findIndex(
				(entry) => getModelType(entry) === getModelType(model) && entry.id === model.id,
			);
			if (index >= 0) merged[index] = model;
			else merged.push(model);
		}
		return merged;
	};
	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			return lazyStream(model, async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		return run(streams);
	};

	const provider: Provider<TApi> = {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: () => currentModels().filter((model): model is Model<TApi> => isModelType(model, "chat")),
		getAllModels: currentModels,
		refreshModels: fetchModels
			? async (context) => {
					if (context.stored) {
						const restored = context.stored.models
							.filter((model) => model.provider === input.id)
							.map((model) => model as ProviderModel<TApi>);
						if (
							!(await context.publish({
								update: () => {
									dynamicModels = restored;
								},
							}))
						) {
							return;
						}
					}
					if (!context.allowNetwork || context.signal.aborted) return;
					const fetched = await fetchModels(context);
					if (context.signal.aborted) return;
					const refreshed = fetched.filter(hasKnownModelType);
					await context.publish({
						persist: { models: refreshed, checkedAt: Date.now() },
						update: () => {
							dynamicModels = refreshed;
						},
					});
				}
			: undefined,
		filterModels: input.filterModels,
		filterAllModels: input.filterAllModels,
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};

	if (streams.some((entry) => entry.fetchDeferred !== undefined)) {
		provider.fetchDeferred = (model, handle, options) =>
			lazyStream(model, async () => {
				const implementation = apiFor(model);
				if (!implementation?.fetchDeferred) {
					throw new ModelsError(
						"provider",
						`Provider ${input.id} does not support deferred responses for "${model.api}"`,
					);
				}
				return implementation.fetchDeferred(model, handle, options);
			});
	}
	if (streams.some((entry) => entry.cancelDeferred !== undefined)) {
		provider.cancelDeferred = async (model, handle, options) => {
			const implementation = apiFor(model);
			if (!implementation?.cancelDeferred) {
				throw new ModelsError(
					"provider",
					`Provider ${input.id} cannot cancel deferred responses for "${model.api}"`,
				);
			}
			await implementation.cancelDeferred(model, handle, options);
		};
	}
	if (images && imageImplementations.length > 0) {
		provider.generateImages = async (model, context, options) => {
			const implementation = images[model.api];
			if (!implementation) {
				return imageErrorResult(
					model,
					new ModelsError(
						"provider",
						`Provider ${input.id} has no image generation implementation for "${model.api}"`,
					),
				);
			}
			return implementation.generateImages(model, context, options);
		};
	}
	if (classifiers && classifierImplementations.length > 0) {
		provider.classify = async (model, context, options) => {
			const implementation = classifiers[model.api];
			if (!implementation) {
				return classifierErrorResult(
					model,
					new ModelsError("provider", `Provider ${input.id} has no classifier implementation for "${model.api}"`),
				);
			}
			return implementation.classify(model, context, options);
		};
	}

	return provider;
}

/**
 * 针对动态查找的模型的运行时检查收窄：
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 *
 * 非聊天模型永远不会匹配，即使其 api id 等于 `api`。
 */
export function hasApi<TApi extends Api>(model: AnyModel, api: TApi): model is Model<TApi> {
	return isModelType(model, "chat") && model.api === api;
}

export function calculateCost(model: AnyModel, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic 对 1 小时缓存写入按 2 倍基础输入计费。
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * 通过比较类型、id 和 provider 判断两个模型是否相等。
 * 任一模型为 null 或 undefined 时返回 false。
 */
export function modelsAreEqual(a: AnyModel | null | undefined, b: AnyModel | null | undefined): boolean {
	if (!a || !b) return false;
	return getModelType(a) === getModelType(b) && a.id === b.id && a.provider === b.provider;
}
