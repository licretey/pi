// 此文件由 scripts/generate-models.ts 自动生成。
// 请勿手动编辑；运行 'npm run generate-models' 进行更新。

import values from "./data/cloudflare-workers-ai.json" with { type: "json" };
import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";

export const CLOUDFLARE_WORKERS_AI_MODELS: ChatModelCatalog<typeof values, "cloudflare-workers-ai"> =
	flattenChatModelCatalog("cloudflare-workers-ai", values);

export const CLOUDFLARE_WORKERS_AI_IMAGE_MODELS: ImageModelCatalog<typeof values, "cloudflare-workers-ai"> =
	flattenImageModelCatalog("cloudflare-workers-ai", values);

export const CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "cloudflare-workers-ai"> =
	flattenClassifierModelCatalog("cloudflare-workers-ai", values);
