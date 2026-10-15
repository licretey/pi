/**
 * 在宿主端测试中替代真实 worker：将作为脚本源码传入的 JSON 消息发回，
 * 这样测试就能发送真实前导代码不会生成的宿主端负载。
 */
import { parentPort, workerData } from "node:worker_threads";

parentPort?.postMessage(JSON.parse((workerData as { code: string }).code));
