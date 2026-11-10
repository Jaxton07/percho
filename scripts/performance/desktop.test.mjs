import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
test("rejects unsafe environment before launching", { skip: process.platform !== "darwin" }, async () => {
	const base = join(repo, ".local/test/performance");
	await mkdir(base, { recursive: true });
	const run = await mkdtemp(join(base, "desktop-test-"));
	try {
		await mkdir(join(run, "work"));
		await assert.rejects(
			withDesktop({ repo, directory: join(run, "work/host"), env: { HOME: "/" } }, () => {}),
			/Unsafe desktop environment/,
		);
	} finally {
		await rm(run, { recursive: true, force: true });
	}
});
