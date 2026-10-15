// 将工作区包解析到其 TypeScript 源码，以便分诊工具无需构建包即可运行。
// 没有 "source" 导出条件的包（如 pi-ai）会解析到 dist/*.js；此处将其映射到 src/*.ts。
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST_JS = /(\/(?:packages|node_modules\/@earendil-works)\/[^/]+)\/dist\/(.+)\.js$/;

function toSource(url) {
	if (!url?.startsWith("file:")) return undefined;
	const path = fileURLToPath(url);
	if (path.includes("/node_modules/") && !path.includes("/node_modules/@earendil-works/")) return undefined;
	if (!DIST_JS.test(path)) return undefined;
	const source = path.replace(DIST_JS, "$1/src/$2.ts");
	if (!existsSync(source)) return undefined;
	// 必须使用真实路径：Node 不会为 node_modules 下的文件剥离类型。
	return pathToFileURL(realpathSync(source)).href;
}

export async function resolve(specifier, context, nextResolve) {
	let result;
	try {
		result = await nextResolve(specifier, context);
	} catch (error) {
		const source = toSource(error?.url);
		if (source) return { url: source, format: "module-typescript", shortCircuit: true };
		throw error;
	}
	const source = toSource(result.url);
	return source ? { url: source, format: "module-typescript", shortCircuit: true } : result;
}
