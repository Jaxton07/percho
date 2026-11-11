import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RunStore } from "./store.mjs";

async function setup(t) {
	const root = await mkdtemp(resolve(".local/tmp/perf-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, store: new RunStore({ root }) };
}
const suite = (value) => ({
	status: "passed",
	contract: {
		version: 1,
		measurementVersion: 2,
		measurementHash: "hash",
		mode: "built",
		fixtureHash: "hash",
		parameters: {},
		viewport: {
			initial: { width: 800, height: 600, dpr: 1 },
			stages: { open: { width: 800, height: 600, dpr: 1 } },
		},
	},
	metrics: [{ name: "time", unit: "ms", value, lowerIsBetter: true }],
	rawFiles: ["raw/sample.json"],
	notes: [],
});
const metadata = {
	label: "first",
	profile: "quick",
	environment: {
		platform: "darwin",
		arch: "arm64",
		osRelease: "1",
		cpuModel: "cpu",
		machineHash: "hash",
		node: "22",
		electron: "30",
	},
	suites: { rendering: suite(10) },
};

async function finish(store, run) {
	await writeFile(
		join(store.root, run.id, "raw/sample.json"),
		JSON.stringify(
			run.suites.images
				? { cases: [{ mode: "one", imageCount: 1 }] }
				: { label: "smoke", samples: [{ stage: "open", elements: 1 }] },
		),
	);
	run.finishedAt = new Date().toISOString();
	run.status = "passed";
	await store.save(run);
}

test("create and list runs in a real private directory", async (t) => {
	const { root, store } = await setup(t);
	const run = await store.create(metadata);
	assert.equal(run.label, "first");
	assert.deepEqual(
		(await store.list()).map((item) => item.id),
		[run.id],
	);
	assert.equal((await stat(join(root, run.id))).mode & 0o777, 0o700);
	assert.equal((await stat(join(root, run.id, "manifest.json"))).mode & 0o777, 0o600);
});

test("save status and explicitly move only valid baselines", async (t) => {
	const { store } = await setup(t);
	const run = await store.create(metadata);
	assert.equal(await store.getBaseline(), null);
	await assert.rejects(store.setBaseline(run.id));
	run.status = "failed";
	await store.save(run);
	assert.equal((await store.read(run.id)).status, "failed");
	await assert.rejects(store.setBaseline(run.id));
	await finish(store, run);
	await store.setBaseline(run.id);
	assert.equal(await store.getBaseline(), run.id);
});

test("compare contracts and environment per suite, ignoring source changes", async (t) => {
	const { store } = await setup(t);
	const before = await store.create(metadata);
	await finish(store, before);
	await store.setBaseline(before.id);
	const after = await store.create({
		...metadata,
		source: { commit: "new" },
		suites: { rendering: suite(15) },
	});
	await finish(store, after);
	let result = await store.compare(after.id, {});
	assert.equal(result.status, "comparable");
	assert.equal(result.suites[0].metrics[0].delta, 5);
	assert.equal(result.suites[0].metrics[0].percent, 50);
	after.environment.node = "23";
	await store.save(after);
	result = await store.compare(after.id, {});
	assert.equal(result.status, "incompatible");
	assert.ok(result.suites[0].reasons.some((reason) => reason.includes("node")));
});

test("legacy import stays reference only and history escapes content", async (t) => {
	const { root, store } = await setup(t);
	const file = join(root, "old.json");
	await writeFile(
		file,
		JSON.stringify({ metrics: [{ name: "<script>", unit: "ms", value: 1, lowerIsBetter: true }] }),
	);
	const legacy = await store.importLegacy({ file, suite: "rendering", label: "<img>" });
	assert.equal(legacy.kind, "legacy");
	await assert.rejects(store.setBaseline(legacy.id));
	const run = await store.create(metadata);
	assert.equal((await store.compare(run.id, { baselineId: legacy.id })).status, "reference-only");
	await store.writeHistory();
	const html = await readFile(join(root, "history.html"), "utf8");
	assert.ok(!html.includes("<img>"));
	assert.ok(html.includes("&lt;img&gt;"));
});

test("history separates compatible groups and ignores source and sdk", async (t) => {
	const { root, store } = await setup(t);
	for (const [node, commit] of [
		["22", "a"],
		["22", "b"],
		["23", "c"],
	]) {
		const run = await store.create({
			...metadata,
			environment: { ...metadata.environment, node, sdk: commit },
			source: { commit },
		});
		await finish(store, run);
	}
	await store.writeHistory();
	const html = await readFile(join(root, "history.html"), "utf8");
	assert.equal((html.match(/Group 1/g) ?? []).length, 2);
	assert.equal((html.match(/Group 2/g) ?? []).length, 1);
});

test("import actual minimap summary metrics without fabricating metadata", async (t) => {
	const { root, store } = await setup(t);
	const file = join(root, "summary.json");
	await writeFile(file, JSON.stringify([{ name: "cold:open", p95Ms: 12, inputP95Ms: null }]));
	const run = await store.importLegacy({ file, suite: "minimap", label: "old" });
	assert.deepEqual(run.suites.minimap.metrics, [
		{ name: "cold:open:p95Ms", unit: "ms", value: 12, lowerIsBetter: true },
	]);
	assert.equal(run.environment, undefined);
});

test("functional suites compare without metrics, but failed runs cannot compare", async (t) => {
	const { store } = await setup(t);
	const functional = {
		...suite(1),
		contract: { ...suite(1).contract, viewport: { width: 800, height: 600, dpr: 1 } },
		metrics: [],
	};
	const before = await store.create({ ...metadata, suites: { images: functional } });
	const after = await store.create({ ...metadata, suites: { images: functional } });
	await finish(store, before);
	await finish(store, after);
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "comparable");
	for (const status of ["failed", "interrupted", "partial", "running"]) {
		after.status = status;
		await store.save(after);
		const result = await store.compare(after.id, { baselineId: before.id });
		assert.equal(result.status, "incompatible");
		assert.ok(result.reasons.some((reason) => reason.includes("run not passed")));
	}
	after.status = "passed";
	after.suites.images = suite(1);
	await store.save(after);
	assert.equal((await store.compare(after.id, { baselineId: before.id })).status, "incompatible");
});

test("legacy raw is preserved privately and unknown documents are rejected", async (t) => {
	const { root, store } = await setup(t);
	const file = join(root, "old.json");
	const raw = JSON.stringify({
		version: 1,
		mode: "dev",
		window: {},
		samples: [{ name: "open", elapsedMs: 10, frames: [8], longTasks: [], rows: 1, railMounted: 1 }],
	});
	await writeFile(file, raw);
	const run = await store.importLegacy({ file, suite: "minimap", label: "raw" });
	assert.deepEqual(run.suites.minimap.rawFiles, ["raw/imported.json"]);
	assert.equal(await readFile(join(root, run.id, "raw/imported.json"), "utf8"), raw);
	assert.equal((await stat(join(root, run.id, "raw/imported.json"))).mode & 0o777, 0o600);
	assert.ok(run.suites.minimap.metrics.some((m) => m.name === "dev:open:p95Ms" && m.value === 10));
	await writeFile(file, JSON.stringify({ arbitrary: true }));
	await assert.rejects(store.importLegacy({ file, suite: "minimap" }));
});

test("invalid runs are rejected or reported without breaking history", async (t) => {
	const { root, store } = await setup(t);
	const good = await store.create(metadata);
	good.status = "passed";
	await store.save(good);
	good.suites = { rendering: suite(Infinity) };
	await assert.rejects(store.save(good));
	good.suites = { rendering: suite(1) };
	good.status = "nonsense";
	await assert.rejects(store.save(good));
	const bad = await store.create(metadata);
	await writeFile(join(root, bad.id, "manifest.json"), "not json");
	const errors = [];
	assert.equal((await store.list({ onError: (error) => errors.push(error) })).length, 1);
	assert.equal(errors[0].id, bad.id);
	await assert.rejects(store.read(bad.id));
	await store.writeHistory();
	assert.match(await readFile(join(root, "history.html"), "utf8"), new RegExp(bad.id));
});

test("history draws isolated escaped compatible metric trends", async (t) => {
	const { root, store } = await setup(t);
	for (const node of ["22", "22", "23"]) {
		const run = await store.create({
			...metadata,
			label: "<unsafe>",
			environment: { ...metadata.environment, node },
		});
		await finish(store, run);
	}
	await store.writeHistory();
	const html = await readFile(join(root, "history.html"), "utf8");
	assert.equal((html.match(/<svg\b/g) ?? []).length, 2);
	assert.equal((html.match(/<polyline\b/g) ?? []).length, 2);
	assert.ok(!html.includes("<unsafe>"));
});

test("reject invalid ids and symlink run directories", async (t) => {
	const { root, store } = await setup(t);
	await assert.rejects(store.read("../outside"));
	await symlink(resolve(".local/tmp"), join(root, "escape"));
	await assert.rejects(store.read("escape"));
	await assert.rejects(new RunStore({ root: join(root, "escape", "new") }).create(metadata));
	const run = await store.create(metadata);
	await rm(join(root, run.id, "manifest.json"));
	await symlink(join(root, "outside"), join(root, run.id, "manifest.json"));
	await assert.rejects(store.read(run.id));
});
