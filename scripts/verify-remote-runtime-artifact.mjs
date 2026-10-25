/** Mount only /runtime (unpacked artifact), /verify (these scripts), /artifacts and isolated /state. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || entry !== "/runtime/entry.mjs")
	throw new Error("Standalone artifact fixture required");
const exec = promisify(execFile);
for (const path of ["/work/packages", "/source/packages", "/work/node_modules", "/source/node_modules"]) {
	await assert.rejects(access(path), { code: "ENOENT" });
}
const checked = JSON.parse(
	(
		await exec(process.execPath, [entry, "check", "--root", "/state/check-must-not-exist"], {
			env: { ...process.env, PI_PACKAGE_DIR: "/unrelated-existing-cli" },
			timeout: 90000,
		})
	).stdout,
);
assert.equal(checked.ok, true);
assert.equal(
	checked.sdkVersion,
	JSON.parse(await readFile("/runtime/package.json", "utf8")).dependencies["@earendil-works/pi-coding-agent"],
);
await assert.rejects(access("/state/check-must-not-exist"), { code: "ENOENT" });
for (const root of ["r", "i", "c", "t", "a", "s"])
	await mkdir(`/state/${root}`, { recursive: true, mode: 0o700 });
const cases = [
	"linux",
	"images",
	"artifact-worker",
	"reconnect",
	"settings",
	"artifact-tools",
	"startup-dialog",
	"paths",
	"half-open",
	"shutdown",
];
for (const name of cases) {
	const result = await exec(process.execPath, [`/verify/verify-remote-runtime-${name}.mjs`], {
		env: { ...process.env, PERCHO_RUNTIME_TEST_PROJECTION: "/artifacts/recovery-projection.mjs" },
		timeout: 240000,
		maxBuffer: 4 * 1024 * 1024,
	});
	process.stdout.write(`${name}: ${result.stdout}`);
}
console.log(
	JSON.stringify({
		passed: true,
		arch: process.arch,
		noRepositoryDependencies: true,
		offlinePackageCheck: true,
		cases,
	}),
);
