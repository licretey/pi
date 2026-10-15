// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/baseten.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const BASETEN_MODELS: ChatModelCatalog<typeof values, "baseten"> =
	flattenChatModelCatalog("baseten", values);

export const BASETEN_IMAGE_MODELS: ImageModelCatalog<typeof values, "baseten"> =
	flattenImageModelCatalog("baseten", values);

export const BASETEN_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "baseten"> =
	flattenClassifierModelCatalog("baseten", values);
