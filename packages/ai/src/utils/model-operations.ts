import type {
	AnyModel,
	Api,
	AssistantImages,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ImageApi,
	ImageModel,
	Model,
	ModelType,
	ModelTypeMap,
} from "../types.ts";
import { ModelsError } from "./models-error.ts";

/** 模型的类型。没有 `type` 的模型视为 chat 模型。 */
export function getModelType(model: AnyModel): ModelType {
	return model.type ?? "chat";
}

/** 运行时校验的模型类型收窄，包括没有 `type` 的旧版 chat 模型。 */
export function isModelType<TType extends ModelType>(model: AnyModel, type: TType): model is ModelTypeMap[TType] {
	return getModelType(model) === type;
}

export function assertChatModel(model: AnyModel): asserts model is Model<Api> {
	if (!isModelType(model, "chat")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a chat model`);
	}
}

export function assertImageModel(model: AnyModel): asserts model is ImageModel<ImageApi> {
	if (!isModelType(model, "image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not an image model`);
	}
}

export function assertClassifierModel(model: AnyModel): asserts model is ClassifierModel<ClassifierApi> {
	if (!isModelType(model, "classifier")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} is not a classifier model`);
	}
}

/** 当目录条目不接受图像输入时，拒绝分类器的图像。 */
export function assertClassifierInputSupported(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
): void {
	if (context.images?.length && !model.input.includes("image")) {
		throw new ModelsError("provider", `Model ${model.provider}/${model.id} does not accept image input`);
	}
}

export function imageErrorResult(model: ImageModel<ImageApi>, error: unknown, aborted = false): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export function classifierErrorResult(
	model: ClassifierModel<ClassifierApi>,
	error: unknown,
	aborted = false,
): ClassifierResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}
