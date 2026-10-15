// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/cerebras.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const CEREBRAS_MODELS: ChatModelCatalog<typeof values, "cerebras"> =
	flattenChatModelCatalog("cerebras", values);

export const CEREBRAS_IMAGE_MODELS: ImageModelCatalog<typeof values, "cerebras"> =
	flattenImageModelCatalog("cerebras", values);

export const CEREBRAS_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "cerebras"> =
	flattenClassifierModelCatalog("cerebras", values);
