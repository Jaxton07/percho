import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RunStore } from "./store.mjs";

test("an explicit suite selection compares an incremental run with a full baseline", async (t) => {
	const root = await mkdtemp(resolve(".local/tmp/perf-selection-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new RunStore({ root });
	const measured = {
		status: "passed",
		contract: {
			version: 1,
			measurementVersion: 2,
			measurementHash: "hash",
			mode: "built",
			fixtureHash: "same",
			parameters: {},
			viewport: { width: 800, height: 600, dpr: 1 },
		},
		metrics: [{ name: "time", value: 10, unit: "ms", lowerIsBetter: true }],
		rawFiles: ["raw/sample.json"],
	};
	const metadata = {
		profile: "full",
		environment: {
			platform: "darwin",
			arch: "arm64",
			osRelease: "one",
			cpuModel: "cpu",
			machineHash: "same",
			node: "22",
			electron: "43",
		},
	};
	const before = await store.create({
		...metadata,
		suites: {
			rendering: {
				...measured,
				rawFiles: ["raw/rendering.json"],
				contract: {
					...measured.contract,
					viewport: { initial: measured.contract.viewport, stages: { open: measured.contract.viewport } },
				},
			},
			"large-text": measured,
		},
	});
	await writeFile(
		join(root, before.id, "raw/rendering.json"),
		JSON.stringify({ label: "smoke", samples: [{ stage: "open", elements: 1 }] }),
	);
	const raw = JSON.stringify({
		status: "passed",
		samples: [{ navigation: 1, ready: 2, firstPaint: 3, views: 0, warmup: false, status: "passed" }],
	});
	await writeFile(join(root, before.id, "raw/sample.json"), raw);
	before.finishedAt = new Date().toISOString();
	before.status = "passed";
	await store.save(before);
	const after = await store.create({ ...metadata, suites: { "large-text": measured } });
	await writeFile(join(root, after.id, "raw/sample.json"), raw);
	after.finishedAt = new Date().toISOString();
	after.status = "passed";
	await store.save(after);
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "incompatible");
	const selected = await store.compare(after.id, { baselineId: before.id, suiteNames: ["large-text"] });
	assert.equal(selected.status, "comparable");
	assert.deepEqual(
		selected.suites.map((suite) => suite.name),
		["large-text"],
	);
	await assert.rejects(store.compare(after.id, { baselineId: before.id, suiteNames: ["missing"] }), /suite/i);
	after.suites["large-text"].contract = { ...measured.contract, measurementHash: "changed" };
	await store.save(after);
	const changedRecipe = await store.compare(after.id, { baselineId: before.id, suiteNames: ["large-text"] });
	assert.equal(changedRecipe.status, "incompatible");
	assert(changedRecipe.suites[0].reasons.some((reason) => reason.includes("measurementHash")));
	after.status = "failed";
	await store.save(after);
	assert.equal(
		(await store.compare(after.id, { baselineId: before.id, suiteNames: ["large-text"] })).status,
		"incompatible",
	);
});
