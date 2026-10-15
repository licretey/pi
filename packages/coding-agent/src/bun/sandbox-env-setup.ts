import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

// 在评估启动时会读取环境变量的模块之前，先恢复环境变量。
restoreSandboxEnv();
