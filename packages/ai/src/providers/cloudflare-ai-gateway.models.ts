// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/cloudflare-ai-gateway.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const CLOUDFLARE_AI_GATEWAY_MODELS: ChatModelCatalog<typeof values, "cloudflare-ai-gateway"> =
	flattenChatModelCatalog("cloudflare-ai-gateway", values);

export const CLOUDFLARE_AI_GATEWAY_IMAGE_MODELS: ImageModelCatalog<typeof values, "cloudflare-ai-gateway"> =
	flattenImageModelCatalog("cloudflare-ai-gateway", values);

export const CLOUDFLARE_AI_GATEWAY_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "cloudflare-ai-gateway"> =
	flattenClassifierModelCatalog("cloudflare-ai-gateway", values);
