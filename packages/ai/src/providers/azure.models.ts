// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/azure.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const AZURE_MODELS: ChatModelCatalog<typeof values, "azure"> =
	flattenChatModelCatalog("azure", values);

export const AZURE_IMAGE_MODELS: ImageModelCatalog<typeof values, "azure"> =
	flattenImageModelCatalog("azure", values);

export const AZURE_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "azure"> =
	flattenClassifierModelCatalog("azure", values);
