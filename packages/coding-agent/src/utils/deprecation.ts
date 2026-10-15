import chalk from "chalk";

const emittedDeprecationWarnings = new Set<string>();

export function warnDeprecation(message: string): void {
	if (emittedDeprecationWarnings.has(message)) return;
	emittedDeprecationWarnings.add(message);
	console.warn(chalk.yellow(`Deprecation warning: ${message}`));
}

/** 清除弃用警告状态。此函数导出供测试使用。 */
export function clearDeprecationWarningsForTests(): void {
	emittedDeprecationWarnings.clear();
}
