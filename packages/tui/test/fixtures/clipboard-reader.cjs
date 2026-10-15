const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

(async () => {
let ticks = 0;
const timer = setInterval(() => ticks++, 10);
const started = performance.now();
try {
	const helper = require(process.argv[2]);
	const pending = helper[process.argv[3]]();
	assert.ok(pending instanceof Promise, "Native reads must return promises");
	const value = await pending;
	const bytes = typeof value === "string" || Buffer.isBuffer(value) ? Buffer.from(value) : undefined;
	console.log(JSON.stringify({
		ok: true,
		value: value === null || (typeof value === "string" && value.length <= 100) ? value : undefined,
		unavailable: value === undefined || undefined,
		length: bytes?.length,
		hash: bytes && createHash("sha256").update(bytes).digest("hex"),
	}));
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: String(error) }));
} finally {
	clearInterval(timer);
	if (performance.now() - started > 200) assert.ok(ticks > 5, "Clipboard I/O must not block the JS event loop");
	// 在 Node 退出前检查，避免进程退出掩盖泄漏的子进程或僵尸进程。
	assert.equal(readFileSync(`/proc/self/task/${process.pid}/children`, "utf8").trim(), "");
}

})().catch((error) => { console.error(error); process.exitCode = 1; });
