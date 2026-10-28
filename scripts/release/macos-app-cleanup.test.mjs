import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { retireMacApplication } from "../macos-app-cleanup.mjs";
import { root } from "./plan.mjs";

async function fixture(t) {
	const parent = join(root, ".local/tmp/macos-app-cleanup-tests");
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(join(parent, "case-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const bundle = join(directory, "build.noindex/mac-arm64/Percho Beta.app");
	await mkdir(join(bundle, "Contents/Frameworks/Percho Helper.app"), { recursive: true });
	await mkdir(join(bundle, "Contents/Frameworks/Percho Helper (GPU).app"));
	await mkdir(join(bundle, "Contents/Frameworks/Electron Framework.framework"));
	const artifact = join(directory, "Percho.dmg");
	await writeFile(artifact, "installer-must-survive");
	return { bundle, artifact };
}

test("retiring a generated app unregisters helpers and preserves installers and retained debug bundles", async (t) => {
	const { bundle, artifact } = await fixture(t);
	const calls = [];
	await retireMacApplication(bundle, { unregister: async (path) => calls.push(path) });
	assert.equal(calls.length, 3);
	assert.equal(calls.at(-1), bundle);
	assert.ok(!calls.some((path) => path.endsWith(".framework")));
	assert.ok((await stat(bundle)).isDirectory());
	const removalStates = [];
	await retireMacApplication(bundle, {
		remove: true,
		unregister: async () => {
			removalStates.push(
				await stat(bundle).then(
					() => "present",
					(error) => error.code,
				),
			);
		},
	});
	assert.deepEqual(removalStates, ["ENOENT", "ENOENT", "ENOENT"]);
	await assert.rejects(stat(bundle), { code: "ENOENT" });
	assert.equal(await readFile(artifact, "utf8"), "installer-must-survive");
});

test("registration failures cannot prevent deletion of an owned temporary bundle", async (t) => {
	const { bundle, artifact } = await fixture(t);
	const warning = t.mock.method(console, "warn", () => {});
	await retireMacApplication(bundle, {
		remove: true,
		unregister: async () => {
			throw new Error("registration unavailable");
		},
	});
	assert.equal(warning.mock.calls.length, 3);
	await assert.rejects(stat(bundle), { code: "ENOENT" });
	assert.equal(await readFile(artifact, "utf8"), "installer-must-survive");
	await assert.rejects(retireMacApplication(join(bundle, ".."), { remove: true }), /absolute generated .app/);
});

test("already absent Launch Services records need no warning", async (t) => {
	const { bundle } = await fixture(t);
	const warning = t.mock.method(console, "warn", () => {});
	await retireMacApplication(bundle, {
		unregister: async () => {
			throw Object.assign(new Error("not registered"), {
				stdout: "failed to scan temporary app: -10814\n from spotlight",
			});
		},
	});
	assert.equal(warning.mock.calls.length, 0);
});
