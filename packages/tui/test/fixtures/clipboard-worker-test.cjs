const assert = require("node:assert/strict");
const { once } = require("node:events");
const { readFile } = require("node:fs/promises");
const { setTimeout: delay } = require("node:timers/promises");
const { isMainThread, parentPort, Worker, workerData } = require("node:worker_threads");

async function waitFor(predicate) {
	const deadline = performance.now() + 5000;
	while (!predicate()) {
		assert.ok(performance.now() < deadline, "Timed out waiting for the private reader");
		await delay(10);
	}
}

(async () => {
	if (!isMainThread) {
		const helper = require(workerData);
		void helper.getText();
		await waitFor(() => helper.state().startsWith("1,"));
		parentPort.postMessage("reading");
		return;
	}
	const [addon, mode] = process.argv.slice(2);
	if (mode === "worker-exit") {
		// 发起任务的环境会在其私有回调仍处于等待状态时卸载。
		const worker = new Worker(__filename, { workerData: addon });
		await once(worker, "message");
		await worker.terminate();
		const helper = require(addon);
		assert.equal(helper.state(), "1,1,1", "The detached operation survives environment teardown");
		helper.release();
		await waitFor(() => helper.state() === "1,0,0");
		assert.equal(await helper.getText(), "text");
		console.log("passed");
		return;
	}
	const helper = require(addon);
	const started = performance.now();
	const pending = helper.getText();
	await waitFor(() => helper.state().startsWith("1,"));
	if (mode === "process-exit") {
		assert.equal(await pending, undefined);
		console.log("passed");
		return; // 私有回调不会结束；Node 仍必须能够自然退出。
	}
	const concurrentStarted = performance.now();
	const concurrent = Array.from({ length: 20 }, (_, index) => helper[index % 2 ? "getText" : "getImage"]());
	// UV_THREADPOOL_SIZE=2 时，第二个被阻塞的原生任务会延迟此处的读取操作。
	await readFile(__filename);
	assert.deepEqual(await Promise.all(concurrent), Array(20).fill(undefined));
	assert.ok(performance.now() - concurrentStarted < 1500, "Concurrent reads and filesystem I/O must remain available");
	assert.equal(await pending, undefined);
	assert.ok(performance.now() - started < 4500, "The shared worker must leave its bounded wait");
	assert.equal(helper.state(), "1,1,1", "Only one private reader may remain blocked");
	assert.equal(await helper.getImage(), undefined);
	assert.equal(helper.state(), "1,1,1", "Another request must not start another private reader");
	helper.release();
	await waitFor(() => helper.state() === "1,0,0");
	assert.equal(await helper.getText(), "text");
	assert.deepEqual(await helper.getImage(), Buffer.from("text"));
	assert.equal(helper.state(), "3,0,0", "Late and successful results must all be freed");
	console.log("passed");
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
