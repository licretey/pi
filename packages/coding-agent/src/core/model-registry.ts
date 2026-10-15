import type {
	Api,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthOperationOptions,
	AuthResult,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	ImageApi,
	ImageModel,
	ImagesContext,
	Model,
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsImagesOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	ModelType,
	ModelTypeMap,
	Provider,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./model-runtime.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";
import type { VirtualModelDefinition } from "./virtual-models.ts";

export type { ProviderConfigInput } from "./provider-composer.ts";
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };
export { clearApiKeyCache } from "./provider-composer.ts";

/**
 * 向扩展公开的同步兼容外观。
 * coding-agent 内部直接使用 ModelRuntime。
 */
export class ModelRegistry {
	private readonly runtime: ModelRuntime;

	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	/** 异步重新加载 models.json；进行同步注册表读取前应等待此操作完成。 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.runtime.refresh(options);
	}

	getError(): string | undefined {
		return this.runtime.getError();
	}

	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	getAvailable(): Model<Api>[] {
		return [...this.runtime.getAvailableSnapshot()];
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	/** 查找非聊天类型的模型，例如 `findOfType("classifier", "typesafe", "jev-latest")`。 */
	findOfType<TType extends ModelType>(
		type: TType,
		provider: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.runtime.hasConfiguredAuth(model.provider);
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const resolution = await this.runtime.getAuth(model);
			if (!resolution) {
				const compatibility = this.runtime.getCompatibilityRequestConfig(model);
				if (compatibility.authHeader) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				return { ok: true, headers: compatibility.headers };
			}
			return {
				ok: true,
				apiKey: resolution.auth.apiKey,
				headers: resolution.auth.headers,
				...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
				env: resolution.env,
			};
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const message =
				cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error:
					message === "authHeader requires a resolved API key"
						? `No API key found for "${model.provider}"`
						: message,
			};
		}
	}

	getProviderAuthStatus(provider: string): AuthStatus {
		return this.runtime.getProviderAuthStatus(provider);
	}

	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	/** 通过已配置的提供商创建流，并在请求时执行身份验证。 */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.runtime.stream(model, context, options);
	}

	/** 使用与提供商无关的选项创建流，并在请求时执行身份验证。 */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.runtime.streamSimple(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.runtime.complete(model, context, options);
	}

	/** 获取指定类型（chat、image、classifier）的所有已知模型；也可限定某个提供商。 */
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.runtime.getModelsOfType(type, provider);
	}

	/** 获取指定类型中凭据可用的提供商所提供的模型。 */
	getAvailableOfType<TType extends ModelType>(
		type: TType,
		provider?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.runtime.getAvailableOfType(type, provider, options);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		provider: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	/** 在请求时执行身份验证，并对结构化状态进行分类；该方法不会以拒绝状态结束。 */
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return this.runtime.classify(model, context, options);
	}

	/** 在请求时执行身份验证并生成图像；该方法不会以拒绝状态结束。 */
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return this.runtime.generateImages(model, context, options);
	}

	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.runtime.getAuth(provider);
	}

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			return (await this.runtime.getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.runtime.isUsingOAuth(model.provider);
	}

	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		if (typeof providerOrName === "string") {
			if (!config) throw new Error("Provider config is required when registering by name");
			this.runtime.registerProvider(providerOrName, config);
			return;
		}
		this.runtime.registerNativeProvider(providerOrName);
	}

	unregisterProvider(providerName: string): void {
		this.runtime.unregisterProvider(providerName);
	}

	registerVirtualModel(definition: VirtualModelDefinition): void {
		this.runtime.registerVirtualModel(definition);
	}

	unregisterVirtualModel(providerName: string, id: string): void {
		this.runtime.unregisterVirtualModel(providerName, id);
	}

	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	getRegisteredProviderIds(): readonly string[] {
		return this.runtime.getRegisteredProviderIds();
	}
}
