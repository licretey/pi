// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/huggingface.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const HUGGINGFACE_MODELS: ChatModelCatalog<typeof values, "huggingface"> =
	flattenChatModelCatalog("huggingface", values);

export const HUGGINGFACE_IMAGE_MODELS: ImageModelCatalog<typeof values, "huggingface"> =
	flattenImageModelCatalog("huggingface", values);

export const HUGGINGFACE_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "huggingface"> =
	flattenClassifierModelCatalog("huggingface", values);
