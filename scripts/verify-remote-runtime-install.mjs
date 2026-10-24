/** Disposable target container: actual archive in /artifacts; desktop bootstrap mounted as /bootstrap.mjs. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { INSTALL_SCRIPT } from "/bootstrap.mjs";

if (process.platform !== "linux" || !["arm64", "x64"].includes(process.arch))
	throw new Error("Target Linux fixture required");
const home = "/state/install-home",
	root = `${home}/.local/share/percho`;
await mkdir(home, { recursive: true, mode: 0o700 });
const manifest = JSON.parse(await readFile(`/artifacts/runtime-linux-${process.arch}.json`, "utf8"));
const archive = await readFile(`/artifacts/percho-runtime-linux-${process.arch}.tar.gz`);
const metadata = (body) => ({
	releaseId: manifest.releaseId,
	arch: process.arch,
	bytes: body.length,
	sha256: createHash("sha256").update(body).digest("hex"),
	protocol: manifest.protocol,
});
function run(body, meta = metadata(body), hold = false) {
	const child = spawn(
		process.execPath,
		["-e", `require('node:os').homedir=()=>${JSON.stringify(home)};${INSTALL_SCRIPT}`, JSON.stringify(meta)],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stdout.resume();
	child.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk).slice(0, 16384);
	});
	child.stdin.on("error", () => {});
	const done = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve({ code, stderr }));
	});
	if (!hold) child.stdin.end(body);
	return { child, done };
}
assert.equal((await run(archive).done).code, 0);
const original = await readFile(`${root}/installed.json`, "utf8"),
	inode = (await stat(`${root}/releases/${manifest.releaseId}`)).ino;
await assert.rejects(access(`${root}/agent`), { code: "ENOENT" });
for (const [body, meta] of [
	[archive, { ...metadata(archive), sha256: "0".repeat(64) }],
	[archive.subarray(0, 4096), metadata(archive)],
	[archive, { ...metadata(archive), arch: process.arch === "arm64" ? "x64" : "arm64" }],
])
	assert.notEqual((await run(body, meta).done).code, 0);
function tar(name, type = 48) {
	const buffer = Buffer.alloc(1536);
	buffer.write(name, 0, 100);
	for (const [offset, size, value] of [
		[100, 8, "0000600"],
		[108, 8, "0000000"],
		[116, 8, "0000000"],
		[124, 12, "00000000000"],
		[136, 12, "00000000000"],
	])
		buffer.write(value, offset, size);
	buffer.fill(32, 148, 156);
	buffer[156] = type;
	buffer.write("ustar\0", 257);
	buffer.write("00", 263);
	const checksum = buffer.subarray(0, 512).reduce((sum, value) => sum + value, 0);
	buffer.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
	return gzipSync(buffer);
}
for (const body of [tar("../../escape"), tar("/outside"), tar("link", 50), tar("hard-link", 49)]) {
	const result = await run(body).done;
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /Unsafe/);
}
const held = run(archive, metadata(archive), true);
held.child.stdin.write(archive.subarray(0, 1024));
const deadline = Date.now() + 10000;
while (!(await readdir(`${root}/staging`)).length) {
	if (Date.now() > deadline) throw Error("Installer did not enter staging");
	await new Promise((resolve) => setTimeout(resolve, 20));
}
try {
	const competing = await run(archive).done;
	assert.notEqual(competing.code, 0);
	assert.match(competing.stderr, /INSTALL_BUSY/);
} finally {
	held.child.stdin.end();
	await held.done;
}
assert.equal(await readFile(`${root}/installed.json`, "utf8"), original);
assert.equal((await stat(`${root}/releases/${manifest.releaseId}`)).ino, inode);
assert.deepEqual(await readdir(`${root}/staging`), []);
await assert.rejects(access(`${root}/escape`), { code: "ENOENT" });
console.log(
	JSON.stringify({
		passed: true,
		arch: process.arch,
		actualArchiveInstalled: true,
		noAgentInitialized: true,
		wrongDigest: true,
		truncatedUpload: true,
		wrongArch: true,
		unsafeTar: true,
		concurrentInstall: true,
		oldReleasePreserved: true,
		stagingCleaned: true,
	}),
);
