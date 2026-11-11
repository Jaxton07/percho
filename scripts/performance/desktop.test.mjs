import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { withDesktop } from "./desktop.mjs";

const repo = resolve(import.meta.dirname, "../..");
test("rejects unsupported platforms or directories outside a run", async () => {
	await assert.rejects(
		withDesktop({ repo, directory: join(repo, "outside") }, () => {}),
		(error) =>
			process.platform === "darwin"
				? /work directory/.test(error.message)
				: error.code === "UNSUPPORTED_PLATFORM",
	);
});
test("validates the performance owner marker", { skip: process.platform !== "darwin" }, async () => {
	const base = join(repo, ".local/test/performance");
	await mkdir(base, { recursive: true });
	const run = await mkdtemp(join(base, "desktop-test-"));
	const owner = randomUUID();
	try {
		await mkdir(join(run, "work"));
		await writeFile(
			join(run, "owner.json"),
			JSON.stringify({ version: 1, kind: "percho-performance-run", owner }),
		);
		await assert.rejects(
			withDesktop(
				{
					repo,
					directory: join(run, "work/host"),
					env: { PERCHO_PERF_RUN_DIR: run, PERCHO_PERF_OWNER: randomUUID() },
				},
				() => {},
			),
			/performance owner mismatch/i,
		);
	} finally {
		await rm(run, { recursive: true, force: true });
	}
});
test("archives startup logs and registers successful cleanup before preparation", {
	skip: process.platform !== "darwin",
}, async () => {
	const base = join(repo, ".local/tmp/performance-tooling");
	await mkdir(base, { recursive: true });
	const fakeRepo = await mkdtemp(join(base, "desktop-startup-"));
	const run = join(fakeRepo, ".local/test/performance/run");
	const cleanupResults = [];
	try {
		await mkdir(join(run, "work"), { recursive: true });
		await assert.rejects(
			withDesktop({ repo: fakeRepo, directory: join(run, "work/host"), cleanupResults }, () => {}),
		);
		assert.equal(cleanupResults.length, 1);
		assert.equal(cleanupResults[0].completed, true);
		const logs = await readdir(join(run, "logs"));
		assert.equal(logs.length, 1);
		assert.equal((await stat(join(run, "logs", logs[0]))).mode & 0o777, 0o600);
		assert.match(await readFile(join(run, "logs", logs[0]), "utf8"), /Desktop error:/);
		assert.equal((await stat(join(run, "work/host/desktop.log"))).mode & 0o777, 0o600);
	} finally {
		await rm(fakeRepo, { recursive: true, force: true });
	}
});

test("rejects unsafe environment before launching", { skip: process.platform !== "darwin" }, async () => {
	const base = join(repo, ".local/test/performance");
	await mkdir(base, { recursive: true });
	const run = await mkdtemp(join(base, "desktop-test-"));
	const cleanupResults = [];
	try {
		await mkdir(join(run, "work"));
		await assert.rejects(
			withDesktop({ repo, directory: join(run, "work/host"), env: { HOME: "/" }, cleanupResults }, () => {}),
			/Unsafe desktop environment/,
		);
		assert.equal(cleanupResults.length, 1);
		assert.equal(cleanupResults[0].completed, true);
		assert.equal(cleanupResults[0].phase, "not-started");
	} finally {
		await rm(run, { recursive: true, force: true });
	}
});
