import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const records = resolve(import.meta.dirname, "../../.local/test/performance");
const repo = resolve(import.meta.dirname, "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the public CLI runs a real catalog benchmark and retains its source data", async () => {
	let id;
	try {
		const result = await exec(
			process.execPath,
			[
				"scripts/performance.mjs",
				"run",
				"--suite=catalog",
				"--profile=quick",
				"--label=cli-integration",
				"--json",
			],
			{
				cwd: repo,
				env: { ...process.env, NODE_OPTIONS: "--no-experimental-webstorage" },
				timeout: 60000,
				maxBuffer: 1024 * 1024,
			},
		);
		const output = JSON.parse(result.stdout);
		id = output.id;
		const directory = join(repo, ".local/test/performance", id);
		const run = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
		assert.equal(run.status, "passed");
		assert.equal(run.suites.catalog.status, "passed");
		assert(run.suites.catalog.metrics.some((metric) => metric.name === "1000.first.refreshTotalMs"));
		const raw = JSON.parse(await readFile(join(directory, "raw/catalog-1000.json"), "utf8"));
		assert.equal(raw.dataset.sessions, 1000);
		assert.deepEqual(raw.budgetFailures, []);
		assert.equal(run.cleanup.completed, true);
	} finally {
		if (id) await rm(join(records, id), { recursive: true, force: true });
	}
});

test("setup failures are retained as failed runs rather than losing the attempt", async () => {
	let id;
	try {
		let output;
		try {
			await exec(process.execPath, ["scripts/performance.mjs", "run", "--suite=catalog", "--json"], {
				cwd: repo,
				env: { ...process.env, PATH: "" },
				timeout: 10000,
			});
			assert.fail("Expected git setup failure");
		} catch (error) {
			assert.equal(error.code, 1);
			output = JSON.parse(error.stdout);
		}
		id = output.id;
		const run = JSON.parse(await readFile(join(records, id, "manifest.json"), "utf8"));
		assert.equal(run.status, "failed");
		assert(run.notes.some((note) => /git|ENOENT/.test(note)));
		assert.equal(run.cleanup.completed, true);
		await assert.rejects(
			exec(process.execPath, ["scripts/performance.mjs", "baseline", "set", id], { cwd: repo }),
			/Baseline.*passed|Only.*passed|failed|Cannot/i,
		);
	} finally {
		if (id) await rm(join(records, id), { recursive: true, force: true });
	}
});

test("work removal failure still saves a final failed manifest and releases the lock", {
	skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
	const label = `cleanup-failure-${process.pid}-${Date.now()}`;
	let id, locked;
	const done = exec(
		process.execPath,
		["scripts/performance.mjs", "run", "--suite=catalog", "--profile=full", `--label=${label}`, "--json"],
		{ cwd: repo, timeout: 60000, maxBuffer: 1024 * 1024 },
	).then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	try {
		const until = Date.now() + 20000;
		while (!id && Date.now() < until) {
			for (const name of await readdir(records)) {
				const state = await readFile(join(records, name, "manifest.json"), "utf8")
					.then(JSON.parse)
					.catch(() => null);
				if (state?.label === label && state.suites.catalog?.status === "running") {
					id = name;
					break;
				}
			}
			if (!id) await pause(20);
		}
		assert(id, "CLI did not reach its owned benchmark");
		locked = join(records, id, "work/undeletable");
		await mkdir(locked, { mode: 0o700 });
		await writeFile(join(locked, "fixture"), "owned data");
		await chmod(locked, 0o500);
		const result = await done;
		assert.equal(result.error?.code, 1);
		const run = JSON.parse(await readFile(join(records, id, "manifest.json"), "utf8"));
		assert.equal(run.status, "failed");
		assert(run.finishedAt);
		assert.equal(run.cleanup.completed, false);
		assert.equal(run.cleanup.workRetained, true);
		assert(run.cleanup.errors.some((message) => /work|remov/i.test(message)));
		await assert.rejects(readFile(join(records, ".run-lock")), { code: "ENOENT" });
	} finally {
		await done;
		if (locked) await chmod(locked, 0o700).catch(() => {});
		if (id) await rm(join(records, id), { recursive: true, force: true });
	}
});

test("preflight failure is recorded exactly once without launching a desktop", {
	skip: process.platform !== "darwin",
}, async () => {
	const bin = await mkdtemp(resolve(".local/tmp/preflight-bin-"));
	const server = createServer();
	let id;
	try {
		await writeFile(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		await new Promise((ok, no) => {
			server.once("error", (error) => (error.code === "EADDRINUSE" ? ok() : no(error)));
			server.listen(5173, "127.0.0.1", ok);
		});
		const result = await exec(
			process.execPath,
			["scripts/performance.mjs", "run", "--suite=images", "--json"],
			{
				cwd: repo,
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
				timeout: 60000,
				maxBuffer: 1024 * 1024,
			},
		).catch((error) => error);
		assert.equal(result.code, 1);
		const run = JSON.parse(result.stdout);
		id = run.id;
		assert.equal(run.status, "failed");
		assert.equal(run.cleanup.operations.length, 1);
		assert.equal(run.cleanup.operations[0].phase, "not-started");
		assert.equal(run.cleanup.operations[0].completed, true);
		assert.match(run.cleanup.operations[0].failure, /port|5173/i);
	} finally {
		if (server.listening) await new Promise((ok) => server.close(ok));
		if (id) await rm(join(records, id), { recursive: true, force: true });
		await rm(bin, { recursive: true, force: true });
	}
});

test("unknown suites are rejected before starting benchmarks", async () => {
	await assert.rejects(
		exec(process.execPath, ["scripts/performance.mjs", "run", "--suite=typo"], { cwd: repo }),
		/Unknown.*suite/,
	);
});
