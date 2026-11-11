import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RunStore } from "./store.mjs";

const viewport = { width: 800, height: 600, dpr: 2 };
const environment = {
	platform: "darwin",
	arch: "arm64",
	osRelease: "1",
	cpuModel: "cpu",
	machineHash: "hash",
	node: "22",
	electron: "30",
};
const measured = (name = "switch") => ({
	status: "passed",
	contract: {
		version: 1,
		measurementVersion: 2,
		measurementHash: "hash",
		mode: "dev",
		fixtureHash: "hash",
		parameters: {},
		viewport: name === "rendering" ? { initial: viewport, stages: { open: viewport } } : viewport,
	},
	metrics: [{ name: "time", unit: "ms", value: 1, lowerIsBetter: true }],
	rawFiles: ["raw/sample.json"],
});
const evidence = {
	switch: {
		version: 1,
		summary: [{ fixture: "one", firstPaint: { p50: 1 } }],
		samples: [{ fixture: "one", firstPaint: 1 }],
	},
	rendering: { label: "smoke", samples: [{ stage: "open", elements: 1 }] },
	images: { cases: [{ mode: "one", imageCount: 1 }] },
	catalog: { phases: [{ phase: "first", refreshTotalMs: 1 }], budgetFailures: [] },
};
async function setup(t, name = "switch") {
	const root = await mkdtemp(resolve(".local/tmp/perf-validity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new RunStore({ root });
	async function make() {
		const run = await store.create({
			profile: "full",
			environment: { ...environment },
			suites: { [name]: measured(name) },
		});
		await writeFile(join(root, run.id, "raw/sample.json"), JSON.stringify(evidence[name]));
		run.status = "passed";
		run.finishedAt = new Date().toISOString();
		await store.save(run);
		return run;
	}
	return { root, store, make };
}
test("auxiliary checkpoints are retained but never replace completed reports", async (t) => {
	const { root, store, make } = await setup(t);
	const before = await make(),
		after = await make();
	for (const run of [before, after]) {
		await writeFile(
			join(root, run.id, "raw/switch-checkpoint.json"),
			JSON.stringify({ status: "running", samples: [] }),
		);
		run.suites.switch.rawFiles.push("raw/switch-checkpoint.json");
		await store.save(run);
	}
	await store.setBaseline(before.id);
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "comparable");
	after.suites.switch.rawFiles = ["raw/switch-checkpoint.json"];
	await store.save(after);
	await assert.rejects(store.setBaseline(after.id));
});
test("invalid completed evidence cannot become baseline, comparison or trend", async (t) => {
	const { root, store, make } = await setup(t);
	const baseline = await make();
	for (const mutate of [
		(run) => {
			run.finishedAt = null;
		},
		(run) => {
			delete run.suites.switch.contract.measurementVersion;
		},
		(run) => {
			run.suites.switch.contract.measurementVersion = 1;
		},
		(run) => {
			delete run.suites.switch.contract.measurementHash;
		},
		(run) => {
			run.suites.switch.contract.measurementHash = "unknown";
		},
		(run) => {
			run.suites.switch.contract.measurementHash = " ";
		},
		(run) => {
			delete run.environment.electron;
		},
		(run) => {
			delete run.suites.switch.contract.viewport;
		},
		(run) => {
			run.suites.switch.metrics = [];
		},
		(run) => {
			run.suites.switch.rawFiles = [];
		},
		(run) => {
			run.suites.switch.rawFiles = ["../outside"];
		},
		(run) => {
			run.suites.switch.rawFiles = ["raw/missing"];
		},
		(run) => {
			run.suites.switch.rawFiles = ["raw/link"];
		},
	]) {
		const run = await make();
		await symlink(join(root, baseline.id, "raw/sample.json"), join(root, run.id, "raw/link"));
		mutate(run);
		await store.save(run);
		await assert.rejects(store.setBaseline(run.id));
		assert.equal((await store.compare(run.id, { baselineId: baseline.id })).status, "incompatible");
		await store.writeHistory();
		const history = await readFile(join(root, "history.md"), "utf8");
		assert.match(history, new RegExp(`Reference only \\| ${run.id}`));
	}
});
test("two old records without complete signatures remain readable references", async (t) => {
	const { root, store, make } = await setup(t);
	const before = await make();
	const after = await make();
	for (const run of [before, after]) {
		delete run.suites.switch.contract.measurementVersion;
		delete run.suites.switch.contract.measurementHash;
		await store.save(run);
		await assert.rejects(store.setBaseline(run.id));
		assert.equal((await store.read(run.id)).suites.switch.contract.measurementHash, undefined);
	}
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "incompatible");
	await store.writeHistory();
	const history = await readFile(join(root, "history.html"), "utf8");
	assert.equal((history.match(/Reference only/g) ?? []).length, 2);
	assert.doesNotMatch(history, /<svg/);
});

test("empty, wrong-suite and failed raw evidence is never eligible", async (t) => {
	const { root, store, make } = await setup(t);
	const baseline = await make();
	for (const raw of [
		"",
		"{}",
		"not json",
		JSON.stringify(evidence.images),
		JSON.stringify({ ...evidence.switch, samples: [] }),
		JSON.stringify({ ...evidence.switch, status: "failed" }),
		JSON.stringify({ ...evidence.switch, status: "running" }),
		JSON.stringify({ ...evidence.switch, samples: [{ fixture: "one", firstPaint: 1, status: "failed" }] }),
	]) {
		const run = await make();
		await writeFile(join(root, run.id, "raw/sample.json"), raw);
		await assert.rejects(store.setBaseline(run.id));
		assert.equal((await store.compare(run.id, { baselineId: baseline.id })).status, "incompatible");
		await store.writeHistory();
		assert.match(
			await readFile(join(root, "history.md"), "utf8"),
			new RegExp(`Reference only \\| ${run.id}`),
		);
	}
});

test("node and functional suites have appropriate eligibility", async (t) => {
	const { store, make } = await setup(t);
	const before = await make();
	const after = await make();
	for (const run of [before, after]) {
		run.suites.switch.contract.mode = "node";
		delete run.suites.switch.contract.viewport;
		delete run.environment.electron;
		await store.save(run);
	}
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "comparable");
	for (const run of [before, after]) {
		run.environment.electron = "30";
		run.suites.images = {
			...run.suites.switch,
			contract: { ...run.suites.switch.contract, mode: "dev", viewport },
			metrics: [],
		};
		delete run.suites.switch;
		await writeFile(join(store.root, run.id, "raw/sample.json"), JSON.stringify(evidence.images));
		await store.save(run);
	}
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "comparable");
	await assert.rejects(store.setBaseline(before.id));
});

test("rendering requires all nested viewports, and node-worker needs no desktop metadata", async (t) => {
	const { store, make } = await setup(t, "rendering");
	const before = await make();
	const after = await make();
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "comparable");
	after.suites.rendering.contract.viewport.stages.open.dpr = 0;
	await store.save(after);
	await assert.rejects(store.setBaseline(after.id));
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "incompatible");
	for (const run of [before, after]) {
		run.suites.catalog = {
			...run.suites.rendering,
			contract: {
				version: 1,
				measurementVersion: 2,
				measurementHash: "hash",
				mode: "node-worker",
				fixtureHash: "hash",
				parameters: {},
			},
		};
		delete run.suites.rendering;
		await writeFile(join(store.root, run.id, "raw/sample.json"), JSON.stringify(evidence.catalog));
		delete run.environment.electron;
		await store.save(run);
	}
	await store.setBaseline(before.id);
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "comparable");
});
