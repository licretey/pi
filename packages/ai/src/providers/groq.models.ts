// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/groq.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const GROQ_MODELS: ChatModelCatalog<typeof values, "groq"> =
	flattenChatModelCatalog("groq", values);

export const GROQ_IMAGE_MODELS: ImageModelCatalog<typeof values, "groq"> =
	flattenImageModelCatalog("groq", values);

export const GROQ_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "groq"> =
	flattenClassifierModelCatalog("groq", values);
