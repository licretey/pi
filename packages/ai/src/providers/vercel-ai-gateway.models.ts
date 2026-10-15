// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/vercel-ai-gateway.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const VERCEL_AI_GATEWAY_MODELS: ChatModelCatalog<typeof values, "vercel-ai-gateway"> =
	flattenChatModelCatalog("vercel-ai-gateway", values);

export const VERCEL_AI_GATEWAY_IMAGE_MODELS: ImageModelCatalog<typeof values, "vercel-ai-gateway"> =
	flattenImageModelCatalog("vercel-ai-gateway", values);

export const VERCEL_AI_GATEWAY_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "vercel-ai-gateway"> =
	flattenClassifierModelCatalog("vercel-ai-gateway", values);
