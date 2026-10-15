// 由 cloudflare.ts 导入。Wrangler 默认的 `CompiledWasm` 规则会把 .wasm 导入变成一个已编译模块。
declare module "@silvia-odwyer/photon/photon_rs_bg.wasm" {
	const module: WebAssembly.Module;
	export default module;
}
