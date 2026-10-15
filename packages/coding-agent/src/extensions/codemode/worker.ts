/**
 * 打包构建中 codemode 沙箱的 Worker 入口。Node 包和 Bun 二进制会将此文件构建为独立入口，
 * 因为此时 pi-codemode 自带的 Worker 文件不在磁盘上；config.ts 中的
 * `getCodemodeWorkerSpecifier()` 会解析此入口。
 */
import "@earendil-works/pi-codemode/worker";
