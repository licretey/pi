import * as durable from "@earendil-works/pi-durable";
import * as environment from "@earendil-works/pi-durable/env";
import * as jsonl from "@earendil-works/pi-durable/storage/jsonl";
import * as sqlite from "@earendil-works/pi-durable/storage/sqlite";

// 保持与运行时无关的公共入口处于活动状态，以便浏览器冒烟构建能发现误导入的 Node 专用适配器或内置模块。
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
