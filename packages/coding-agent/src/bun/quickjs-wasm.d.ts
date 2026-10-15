// 由 runtime-setup.ts 导入。Bun 默认会将 .wasm 加载结果解析为文件路径。
declare module "quickjs-wasi/quickjs.wasm" {
	const path: string;
	export default path;
}
