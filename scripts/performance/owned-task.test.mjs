import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runOwnedTask } from "./owned-task.mjs";
import { runProcess } from "./process.mjs";

test("interruption waits for the owned callback and its real child to stop", async () => {
	const base = resolve(".local/tmp/performance-tooling");
	await mkdir(base, { recursive: true });
	const dir = await mkdtemp(join(base, "owned-task-"));
	const controller = new AbortController();
	try {
		const ready = join(dir, "ready");
		const done = join(dir, "done");
		const task = runOwnedTask({ signal: controller.signal }, async () => {
			try {
				await runProcess({
					args: [
						"-e",
						`process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),300)); require('fs').writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000)`,
					],
					logFile: join(dir, "child.log"),
					signal: controller.signal,
				});
			} finally {
				await writeFile(done, "settled");
			}
		});
		while (true) {
			try {
				await readFile(ready);
				break;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
				await new Promise((r) => setTimeout(r, 10));
			}
		}
		controller.abort(new Error("interrupted"));
		await assert.rejects(task, /interrupted/);
		assert.equal(await readFile(done, "utf8"), "settled");
	} finally {
		controller.abort();
		await rm(dir, { recursive: true, force: true });
	}
});

test("abort closes owned resources and waits for callback rejection", async () => {
	const controller = new AbortController();
	let release;
	const task = runOwnedTask(
		{ signal: controller.signal, cancel: () => release() },
		() =>
			new Promise((_, reject) => {
				release = () => reject(new Error("closed"));
			}),
	);
	controller.abort(new Error("interrupted"));
	await assert.rejects(task, /closed/);
});
