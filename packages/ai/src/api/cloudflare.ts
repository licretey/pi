/** Workers AI 直连端点。 */
export const CLOUDFLARE_WORKERS_AI_BASE_URL =
	"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";

/** Workers AI REST 端点根路径；模型运行请求会发送到 `run`。 */
export const CLOUDFLARE_WORKERS_AI_REST_BASE_URL =
	"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai";

/** AI Gateway 统一 API：https://developers.cloudflare.com/ai-gateway/usage/unified-api/ */
export const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat";

/** AI Gateway → OpenAI 透传端点；在 /compat 支持 /v1/responses 前使用。 */
export const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai";

/** AI Gateway → Anthropic 透传端点。 */
export const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic";
