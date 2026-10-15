// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/minimax.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const MINIMAX_MODELS: ChatModelCatalog<typeof values, "minimax"> =
	flattenChatModelCatalog("minimax", values);

export const MINIMAX_IMAGE_MODELS: ImageModelCatalog<typeof values, "minimax"> =
	flattenImageModelCatalog("minimax", values);

export const MINIMAX_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "minimax"> =
	flattenClassifierModelCatalog("minimax", values);
