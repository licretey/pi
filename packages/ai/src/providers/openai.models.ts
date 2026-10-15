// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/openai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const OPENAI_MODELS: ChatModelCatalog<typeof values, "openai"> =
	flattenChatModelCatalog("openai", values);

export const OPENAI_IMAGE_MODELS: ImageModelCatalog<typeof values, "openai"> =
	flattenImageModelCatalog("openai", values);

export const OPENAI_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "openai"> =
	flattenClassifierModelCatalog("openai", values);
