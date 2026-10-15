// 编译后的二进制需要 jiti 的静态入口，以便 Bun 和 SEA 打包器嵌入 Babel 转换器。
// 模块本身仍会延迟加载，直到实际加载扩展时才初始化。
export { createJiti } from "jiti/static";
