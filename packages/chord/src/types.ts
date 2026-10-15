import type { Draft, Op } from "./delta/index.ts";
import type { RemoteServiceProvider } from "./services/provider.ts";

export type { RemoteServiceError } from "./services/errors.ts";
export type { RemoteServiceProvider } from "./services/provider.ts";

/** {@link Context} 中某个值的带类型标识。 */
export interface ContextKey<T> {
	readonly token: symbol;
	/** 仅用于类型检查的标记，防止值类型不同的键被互换使用。 */
	readonly valueType?: (value: T) => T;
}

/** 不可变的调用级值，通过操作显式传递。 */
export interface Context {
	readonly abortSignal: AbortSignal | undefined;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;

/** 应用数据类型的严格 JSON 表示；未知负载使用 JsonValue 表示。 */
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: T extends null | boolean | number | string
			? T
			: T extends readonly (infer TItem)[]
				? JsonRepresentation<TItem>[]
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<T[TKey]> }
					: never;

export interface ReplicatedStateDelivery {
	readonly kind: "hydrate" | "update";
	readonly sequence: number;
}

export interface ReplicatedState<T> {
	/**
	 * 按契约视为不可变的值；完成水合前为 undefined。该值并未冻结，且可能与进程内提供方共享容器，
	 * 因此使用方不得修改它。后续更新不会改变此前返回的值。
	 */
	readonly value: T | undefined;
	/**
	 * 每个订阅都会串行执行回调，并在更新前等待水合完成。值不可变，且不同修订版本之间可能共享未更改的数据。
	 * 正在运行的回调之后最多排队 100 次送达；超出上限时只保留最新的待处理值、上下文和送达信息，
	 * 因此更新序列可能跳过部分版本。失败会单独报告，不影响后续送达。取消订阅会丢弃待处理任务，但不会中止或等待正在运行的回调。
	 */
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => Promise<void>): () => void;
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void;
}

export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
	readonly value: T;
	/**
	 * 原子地发布一次同步覆盖层变更。回调返回后，草稿句柄即不可再用。
	 * 通过草稿写入的值会按值克隆；将对象属性设为 `undefined` 会删除该属性。
	 */
	change(context: Context, mutate: (draft: Draft<T>) => void): void;
	/**
	 * 原子地接管一个无别名且符合严格 JSON 约束的替换值，并将其视为不可变数据。
	 * 调用后，调用方不得再修改已移交的根对象。
	 */
	replace(context: Context, value: T): void;
}

/** 建立附件快照后提交的一个不可变权威版本。 */
export interface ReplicatedStateSourceFrame<T> {
	/** 单调递增的来源游标。快照后的第一帧必须为 `snapshot.cursor + 1`。 */
	readonly cursor: number;
	/** 此次提交产生的确切不可变值。 */
	readonly value: T;
	/** 从上一个来源版本生成 `value` 的确切不可变操作批次。 */
	readonly ops: readonly Op[];
	readonly context: Context;
}

export interface ReplicatedStateSourceAttachment<T> {
	/** 在原子附加边界捕获的固定不可变快照。 */
	readonly snapshot: { readonly value: T; readonly cursor: number };
	/**
	 * 安装唯一的监听器，并按照来源提交顺序同步排空所有缓冲帧。
	 * 此方法只能调用一次。调用后，直至释放前，每个新提交的帧都必须按顺序送达，
	 * 也包括送达前一帧期间重入产生的提交。
	 */
	activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void;
	/** 停止传递并释放来源资源；释放操作必须可重复调用。 */
	dispose(): void;
}

/**
 * 权威的不可变修订版本来源。
 *
 * `attach()` 必须同步且原子地捕获一个快照，并注册返回的附加关系以缓冲
 * 以及此后的每个已提交帧。快照必须包含边界前的所有提交；缓冲帧必须包含边界后的所有提交，不能重叠或遗漏。
 * 快照值、帧值和操作批次均不可变，并在送达后继续有效。Chord 只发布这些引用，不会应用或重新计算差异。
 */
export interface ReplicatedStateSource<T> {
	attach(): ReplicatedStateSourceAttachment<T>;
}

export interface ReplicatedStateSourceOptions {
	/** 接收来源契约或发布监听器错误，且不会将错误抛回来源。 */
	readonly onError?: (error: Error) => void;
}

/** 由单个来源附加关系支撑、同步完成水合且仅负责发布的状态。 */
export interface AttachedReplicatedState<T> extends ReplicatedState<T> {
	readonly value: T;
	/** 可重复地释放来源附加关系；最后发布的值仍可读取。 */
	dispose(): void;
}

declare const SERVICE_TYPE: unique symbol;

export type ServiceMode = "singleton" | "keyed";

/** 一个共享 TypeScript 服务契约的稳定标识。 */
export interface Service<T> {
	readonly id: string;
	/** 进程内服务接受不受限制的对象契约，且绝不会发布到远程。 */
	readonly local: boolean;
	readonly [SERVICE_TYPE]?: (value: T) => T;
}

/** 容器只读的 JSON，例如其他软件包中递归定义的 JSON 类型。 */
type ReadonlyJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly ReadonlyJsonValue[]
	| { readonly [key: string]: ReadonlyJsonValue };

// 可赋值给只读 JSON 的类型本身就是有效类型。若递归遍历 JSON 类型（例如包含只读数组的类型），遍历将无法终止。
type InvalidJsonPart<T> = IsAny<T> extends true
	? T
	: unknown extends T
		? never
		: [T] extends [ReadonlyJsonValue]
			? never
			: InvalidJsonStructure<T>;

type InvalidJsonProperty<T> = [Exclude<T, undefined>] extends [never] ? T : InvalidJsonPart<Exclude<T, undefined>>;

type InvalidJsonStructure<T> = T extends null | boolean | number | string
	? never
	: T extends readonly (infer TItem)[]
		? InvalidJsonPart<TItem>
		: T extends (...args: never[]) => unknown
			? T
			: T extends object
				? { [TKey in keyof T]-?: InvalidJsonProperty<T[TKey]> }[keyof T]
				: T;

type InvalidRemoteMember<T> = T extends ReplicatedState<infer TValue>
	? InvalidJsonPart<TValue> extends never
		? never
		: "state value is not JSON"
	: T extends (...args: [...infer TArgs, Context]) => Promise<infer TResult>
		? InvalidJsonPart<TArgs[number]> extends never
			? TResult extends void
				? never
				: InvalidJsonPart<TResult> extends never
					? never
					: "method result is not JSON or void"
			: "method argument is not JSON"
		: "member is not a remote method or ReplicatedState";

type InvalidRemoteMemberNames<T> = {
	[TKey in keyof T]-?: InvalidRemoteMember<T[TKey]> extends never ? never : TKey;
}[keyof T];

export type RemoteServiceContract<T> = InvalidRemoteMemberNames<T> extends never ? T : never;

export interface ServiceSpawner<T> {
	spawn(key: string, implementation: T): () => void;
}

export interface RemoteServices {
	use<T>(service: Service<T>): T;
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void;
	/** 等待所有当前已获取的服务安装初始快照。 */
	ready(context: Context): Promise<void>;
	dispose(context: Context): Promise<void>;
}

export type ServiceCatalogueEntry = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
};

export type ServiceInstanceAddress = {
	readonly key: string;
	readonly generation: number;
};

export type ServiceMemberSnapshot =
	| { readonly name: string; readonly kind: "method" }
	| { readonly name: string; readonly kind: "state"; readonly sequence: number; readonly ops: readonly Op[] };

export type ServiceInstanceSnapshot = {
	readonly instance?: ServiceInstanceAddress;
	readonly members: readonly ServiceMemberSnapshot[];
};

export type ServiceSubscriptionSnapshot = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	readonly instances: readonly ServiceInstanceSnapshot[];
};

export type ServiceProviderUpdate =
	| {
			readonly type: "state";
			readonly instance?: ServiceInstanceAddress;
			readonly member: string;
			readonly sequence: number;
			readonly ops: readonly Op[];
	  }
	/** 溢出后重新建立完整订阅基线；每个状态都会在新序列号处整体替换根值。 */
	| { readonly type: "reset"; readonly snapshot: ServiceSubscriptionSnapshot }
	| { readonly type: "unavailable" }
	| { readonly type: "replaced"; readonly snapshot: ServiceInstanceSnapshot }
	| { readonly type: "spawned"; readonly instance: ServiceInstanceSnapshot }
	| { readonly type: "closed"; readonly instance: ServiceInstanceAddress };

export type ServiceCall = {
	readonly serviceId: string;
	readonly instance?: ServiceInstanceAddress;
	readonly member: string;
	/** 借用的不可变值。Chord 会验证这些值，但不会克隆它们。 */
	readonly args: readonly JsonValue[];
};

export interface ServiceSubscription {
	/** 原子基线。后续更新会缓冲至激活；待传递数量达到 101 时执行完整重置。 */
	readonly snapshot: ServiceSubscriptionSnapshot;
	activate(): void;
	close(context?: Context): void | Promise<void>;
}

/**
 * 远程服务绑定使用的可插拔通信边界。
 *
 * 实现方负责选择传输方式、分帧、路由和信封编码。通过此边界传递的值必须符合严格 JSON 约束。
 * Chord 不会克隆值，也不要求特定的应用层通信协议；序列化以及所需的隔离副本由适配器负责。
 *
 */
export interface RemoteServiceTransport {
	invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined>;
	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
		context: Context,
	): Promise<ServiceSubscription>;
}

export interface RemoteServiceBindingOptions {
	readonly services: readonly { readonly id: string }[];
	readonly transport: RemoteServiceTransport;
	readonly bound?: boolean;
	readonly onError?: (error: Error) => void;
	readonly assertAccess?: () => void;
}

export interface RemoteServiceBinding extends RemoteServices {
	rebind(bound: boolean, context: Context): Promise<void>;
}

export interface FacetEnvironment {
	/** 声明对单例服务的硬依赖，并返回其稳定句柄。 */
	use<T>(service: Service<T>): T;
	/** 声明对键控服务的硬依赖，并监听每个活动实例。 */
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): void;
	/** 声明并安装此 facet 提供的单例服务实现。 */
	provide<T>(service: Service<T>, implementation: NoInfer<T>): void;
	/** 声明对此多实例服务的所有权，并返回延迟创建实例的能力。 */
	provideMany<T>(service: Service<T>): ServiceSpawner<T>;
	/**
	 * 接管一个无别名且符合严格 JSON 约束的根对象，以创建已初始化的可变状态；接管后将该对象视为不可变数据。
	 * 调用后，调用方不得再修改 `initial`。
	 */
	replicatedState<T extends object>(initial: T): MutableReplicatedState<T>;
	/** 将资源清理函数的所有权交给此 facet。 */
	own(disposal: () => void | Promise<void>): void;
	/** 注册异步初始化操作，在依赖完成绑定并就绪后执行。 */
	onActivate(callback: () => void | Promise<void>): void;
	/** 注册 facet 的最终清理操作。 */
	onDeactivate(callback: () => void | Promise<void>): void;
}

export interface Facet {
	readonly id: string;
	setup(env: FacetEnvironment): void;
}

export interface RemoteServiceSource {
	/** 当前不可用的来源是否可以暂时满足缺失的依赖要求。 */
	readonly acceptsUnavailableServices: boolean;
	catalogue(context: Context): Promise<readonly ServiceCatalogueEntry[]>;
	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices;
}

export interface FacetOptions {
	readonly facets: readonly Facet[];
	readonly serviceSources?: readonly RemoteServiceSource[];
	readonly onError?: (error: Error) => void;
}

export interface FacetHost {
	readonly services: RemoteServiceProvider;
	/** 激活并替换 ID 匹配的 facet，同时保持使用方的服务句柄不断开。 */
	reload(facets: readonly Facet[]): Promise<void>;
	dispose(): Promise<void>;
}

export interface LoadedFacets {
	readonly facets: readonly Facet[];
	dispose(): Promise<void>;
}

export interface FacetLoader {
	load(): Promise<LoadedFacets>;
}
