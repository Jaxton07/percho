import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { archiveSuiteArtifacts } from "./artifacts.mjs";

test("failed collection archives completed checkpoints without overwriting raw evidence", async (t) => {
	await mkdir(resolve(".local/tmp"), { recursive: true });
	const runDir = await mkdtemp(resolve(".local/tmp/artifacts-"));
	t.after(() => rm(runDir, { recursive: true, force: true }));
	await mkdir(join(runDir, "raw"));
	const source = join(runDir, "work/rendering/performance");
	await mkdir(source, { recursive: true });
	await writeFile(join(source, "performance-checkpoint.json"), '{"samples":[{"mountRoundTripMs":42}]}');
	const files = await archiveSuiteArtifacts({ runDir, suite: "rendering" });
	assert(files.some((file) => file.includes("checkpoint")));
	assert.match(await readFile(join(runDir, files[0]), "utf8"), /42/);
	assert.equal((await stat(join(runDir, files[0]))).mode & 0o777, 0o600);
	await writeFile(join(source, "performance-checkpoint.json"), "changed");
	await archiveSuiteArtifacts({ runDir, suite: "rendering" });
	assert.match(await readFile(join(runDir, files[0]), "utf8"), /42/);
});
test("a minimap failure before final output still archives its incremental checkpoint", async (t) => {
	const runDir = await mkdtemp(resolve(".local/tmp/artifacts-"));
	t.after(() => rm(runDir, { recursive: true, force: true }));
	await mkdir(join(runDir, "raw"));
	await mkdir(join(runDir, "work/minimap/launch-1"), { recursive: true });
	await writeFile(
		join(runDir, "work/minimap/launch-1/minimap-checkpoint.json"),
		'{"status":"failed","samples":[{"elapsedMs":42}]}',
	);
	const files = await archiveSuiteArtifacts({ runDir, suite: "minimap" });
	assert.deepEqual(files, ["raw/minimap-1-checkpoint.json"]);
	assert.match(await readFile(join(runDir, files[0]), "utf8"), /42/);
});
test("checkpoint archiving refuses symlink sources", async (t) => {
	const runDir = await mkdtemp(resolve(".local/tmp/artifacts-"));
	t.after(() => rm(runDir, { recursive: true, force: true }));
	await mkdir(join(runDir, "raw"));
	await mkdir(join(runDir, "work/minimap/launch-1"), { recursive: true });
	await writeFile(join(runDir, "outside.json"), "private");
	await symlink(join(runDir, "outside.json"), join(runDir, "work/minimap/launch-1/minimap-results.json"));
	await assert.rejects(archiveSuiteArtifacts({ runDir, suite: "minimap" }), /symbolic|symlink/i);
});
