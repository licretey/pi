// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/moonshotai-cn.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const MOONSHOTAI_CN_MODELS: ChatModelCatalog<typeof values, "moonshotai-cn"> =
	flattenChatModelCatalog("moonshotai-cn", values);

export const MOONSHOTAI_CN_IMAGE_MODELS: ImageModelCatalog<typeof values, "moonshotai-cn"> =
	flattenImageModelCatalog("moonshotai-cn", values);

export const MOONSHOTAI_CN_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "moonshotai-cn"> =
	flattenClassifierModelCatalog("moonshotai-cn", values);
