// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/anthropic.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const ANTHROPIC_MODELS: ChatModelCatalog<typeof values, "anthropic"> =
	flattenChatModelCatalog("anthropic", values);

export const ANTHROPIC_IMAGE_MODELS: ImageModelCatalog<typeof values, "anthropic"> =
	flattenImageModelCatalog("anthropic", values);

export const ANTHROPIC_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "anthropic"> =
	flattenClassifierModelCatalog("anthropic", values);
