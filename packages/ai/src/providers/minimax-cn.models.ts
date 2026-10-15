// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/minimax-cn.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const MINIMAX_CN_MODELS: ChatModelCatalog<typeof values, "minimax-cn"> =
	flattenChatModelCatalog("minimax-cn", values);

export const MINIMAX_CN_IMAGE_MODELS: ImageModelCatalog<typeof values, "minimax-cn"> =
	flattenImageModelCatalog("minimax-cn", values);

export const MINIMAX_CN_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "minimax-cn"> =
	flattenClassifierModelCatalog("minimax-cn", values);
