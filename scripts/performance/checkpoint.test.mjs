import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCheckpoint, safeErrorMessage } from "./checkpoint.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../.local/tmp/performance-tooling");
test("checkpoints persist ordered snapshots atomically on the real filesystem", async () => {
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "checkpoint-test-"));
	try {
		const file = join(dir, "raw.json");
		const checkpoint = createCheckpoint(file);
		const samples = [{ value: 1 }];
		const first = checkpoint.save({ status: "running", samples });
		samples.push({ value: 2 });
		await first;
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
			status: "running",
			samples: [{ value: 1 }],
		});
		await checkpoint.save({ status: "failed", samples });
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { status: "failed", samples });
		await checkpoint.flush();
		assert.deepEqual(await readdir(dir), ["raw.json"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("failure message removes paths and credentials", () => {
	const message = safeErrorMessage(new Error("bad /Users/person/private/file token=abc password: secret"));
	assert(!message.includes("/Users/person"));
	assert(!message.includes("abc"));
	assert(!message.includes("secret"));
	assert.equal(safeErrorMessage(new Error("GC retained views")), "GC retained views");
});
