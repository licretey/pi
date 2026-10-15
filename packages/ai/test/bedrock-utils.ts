/**
 * Amazon Bedrock 测试使用的工具函数。
 */

/**
 * 检查是否已为 Bedrock 配置有效的 AWS 凭据。
 * 设置以下任一项时返回 true：
 * - AWS_PROFILE（~/.aws/credentials 中的命名配置）。
 * - AWS_ACCESS_KEY_ID 和 AWS_SECRET_ACCESS_KEY（IAM 密钥）。
 * - AWS_BEARER_TOKEN_BEDROCK（Bedrock API 密钥）。
 */
export function hasBedrockCredentials(): boolean {
	return !!(
		process.env.AWS_PROFILE ||
		(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
		process.env.AWS_BEARER_TOKEN_BEDROCK
	);
}
