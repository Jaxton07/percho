import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateNoSymlinks, validateRunOwner, validateRunPath, validateWorkPath } from "./paths.mjs";

test("accepts only non-symlink paths in a run work directory", async () => {
	const baseDir = join(dirname(fileURLToPath(import.meta.url)), "../../.local/tmp/performance-tooling");
	await mkdir(baseDir, { recursive: true });
	const repo = await mkdtemp(join(await realpath(baseDir), "perf-paths-"));
	try {
		const base = join(repo, ".local/test/performance");
		await mkdir(join(base, "run/work"), { recursive: true });
		assert.equal(validateWorkPath(repo, join(base, "run/work/rendering")), join(base, "run/work/rendering"));
		assert.throws(() => validateWorkPath(repo, join(base, "run/raw")));
		assert.throws(() => validateWorkPath(repo, join(repo, ".local/tmp/foo")));
		await symlink(join(base, "run/work"), join(base, "run/work/link"));
		assert.throws(() => validateWorkPath(repo, join(base, "run/work/link/child")));
		assert.throws(() => validateNoSymlinks(join(base, "run/work/link/result.json")));
		const run = join(base, "run");
		assert.equal(validateRunPath(repo, run), run);
		assert.throws(() => validateRunPath(repo, join(run, "work")));
		assert.throws(() => validateRunOwner(repo, run, "owner"));
		await writeFile(
			join(run, "owner.json"),
			JSON.stringify({ version: 1, kind: "percho-performance-run", owner: "owner" }),
		);
		validateRunOwner(repo, run, "owner");
		assert.throws(() => validateRunOwner(repo, run, "other"));
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});
