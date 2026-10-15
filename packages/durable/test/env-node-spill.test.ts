import type * as Fs from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

// 此延迟长于 shell 退出后的 stdio 宽限期与后代进程延迟写入所需的时间。
const SPILL_WRITE_DELAY_MS = 600;
const spill = vi.hoisted(() => ({ rejectedWrites: 0 }));

// 让溢写流稳定地变慢，并立即产生背压。
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		createWriteStream: (path: Fs.PathLike, options?: Parameters<typeof Fs.createWriteStream>[1]) => {
			const stream = actual.createWriteStream(
				path,
				typeof options === "object" ? { ...options, highWaterMark: 1 } : { highWaterMark: 1 },
			);
			const writeChunk = stream._write.bind(stream);
			stream._write = (chunk, encoding, callback) => {
				setTimeout(() => writeChunk(chunk, encoding, callback), SPILL_WRITE_DELAY_MS);
			};
			const writeChunks = stream._writev?.bind(stream);
			if (writeChunks !== undefined) {
				stream._writev = (chunks, callback) => {
					setTimeout(() => writeChunks(chunks, callback), SPILL_WRITE_DELAY_MS);
				};
			}
			const write = stream.write.bind(stream);
			stream.write = ((...args: Parameters<Fs.WriteStream["write"]>) => {
				const accepted = Reflect.apply(write, stream, args) as boolean;
				if (!accepted) spill.rejectedWrites++;
				return accepted;
			}) as Fs.WriteStream["write"];
			return stream;
		},
	};
});

const tempDirs: string[] = [];

afterEach(() => {
	spill.rejectedWrites = 0;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("NodeExecutionEnv spill backpressure", () => {
	it.skipIf(process.platform === "win32")(
		"keeps inherited stdio open past the exit grace period while a spill write is pending",
		async () => {
			const root = join(tmpdir(), `pi-durable-env-spill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(root, { recursive: true });
			tempDirs.push(root);
			const env = new NodeExecutionEnv({ cwd: root });
			// 第一块数据超过溢写阈值并使溢写过程产生背压后，shell 就会退出。后台后代进程仍持有 stdout，
			// 并在退出宽限期结束后写入数据。若没有待处理溢写保护，操作结束时会在读取后代进程输出前销毁 stdout。
			const command = "printf '%020d' 0 | tr 0 a; (sleep 0.2; printf '%01000d' 0 | tr 0 b) &";

			let output = "";
			const result = getOrThrow(
				await env.exec(
					command,
					{
						spill: { afterBytes: 10, afterLines: 10 },
						onOutput: (text) => {
							output += text;
						},
					},
					BACKGROUND_CONTEXT,
				),
			);

			expect(spill.rejectedWrites).toBeGreaterThan(0);
			expect(output).toHaveLength(1020);
			expect(result.spillPath).toBeDefined();
			tempDirs.push(join(result.spillPath!, ".."));
			expect(getOrThrow(await env.readTextFile(result.spillPath!, BACKGROUND_CONTEXT))).toBe(
				`${"a".repeat(20)}${"b".repeat(1000)}`,
			);
		},
		10_000,
	);
});
