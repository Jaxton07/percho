import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { measurementFingerprint } from "./measurement.mjs";

test("orchestration, aggregation, cancellation and collector changes partition measurement contracts", async (t) => {
	const repo = await mkdtemp(resolve(".local/tmp/fingerprint-"));
	t.after(() => rm(repo, { recursive: true, force: true }));
	await cp(resolve("scripts"), join(repo, "scripts"), { recursive: true });
	for (const file of [
		"packages/desktop/src/main/session-switch-diagnostics.ts",
		"packages/desktop/src/renderer/src/lib/run-session-switch-diagnostics.ts",
	]) {
		const target = join(repo, file);
		await mkdir(dirname(target), { recursive: true });
		await cp(resolve(file), target);
	}
	const before = await measurementFingerprint(repo);
	for (const name of ["suites", "rendering-report", "cli", "owned-task"]) {
		const path = join(repo, `scripts/performance/${name}.mjs`),
			original = await readFile(path);
		await writeFile(path, Buffer.concat([original, Buffer.from("\n// changed\n")]));
		assert.notEqual(await measurementFingerprint(repo), before, name);
		await writeFile(path, original);
	}
	assert.equal(await measurementFingerprint(repo), before);
});
