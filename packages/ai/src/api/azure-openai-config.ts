import type { Api, Model, StreamOptions } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

const DEFAULT_AZURE_API_VERSION = "v1";

/** Azure 模型未预设 baseUrl：每位用户使用各自的资源地址，并在每次请求时解析。 */
export interface AzureEndpointOptions extends StreamOptions {
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
}

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function resolveDeploymentName(model: Pick<Model<Api>, "id">, options?: AzureEndpointOptions): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseDeploymentNameMap(
		getProviderEnvValue("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options?.env),
	).get(model.id);
	return mappedDeployment || model.id;
}

function normalizeAzureBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
	}

	const isAzureHost =
		url.hostname.endsWith(".openai.azure.com") ||
		url.hostname.endsWith(".cognitiveservices.azure.com") ||
		url.hostname.endsWith(".ai.azure.com");
	const normalizedPath = url.pathname.replace(/\/+$/, "");

	// 确保 Azure 主机的基础路径包含 /openai/v1，以便 AzureOpenAI SDK 能正确追加
	// /deployments/<model>/... 和 ?api-version=v1。
	if (
		isAzureHost &&
		(normalizedPath === "" ||
			normalizedPath === "/" ||
			normalizedPath === "/openai" ||
			normalizedPath === "/openai/v1/responses")
	) {
		url.pathname = "/openai/v1";
		url.search = "";
	}

	return url.toString().replace(/\/+$/, "");
}

function buildDefaultBaseUrl(resourceName: string): string {
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

export function resolveAzureBaseUrl(model: Pick<Model<Api>, "baseUrl">, options?: AzureEndpointOptions): string {
	const baseUrl =
		options?.azureBaseUrl?.trim() || getProviderEnvValue("AZURE_OPENAI_BASE_URL", options?.env)?.trim() || undefined;
	const resourceName = options?.azureResourceName || getProviderEnvValue("AZURE_OPENAI_RESOURCE_NAME", options?.env);

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return normalizeAzureBaseUrl(resolvedBaseUrl);
}

export function resolveAzureConfig(
	model: Pick<Model<Api>, "baseUrl">,
	options?: AzureEndpointOptions,
): { baseUrl: string; apiVersion: string } {
	return {
		baseUrl: resolveAzureBaseUrl(model, options),
		apiVersion:
			options?.azureApiVersion ||
			getProviderEnvValue("AZURE_OPENAI_API_VERSION", options?.env) ||
			DEFAULT_AZURE_API_VERSION,
	};
}
