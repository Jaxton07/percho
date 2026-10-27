/** Disposable Linux container: /work read-only, /state/g private tmpfs. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || !entry?.startsWith("/work/"))
	throw new Error("Isolated Linux fixture required");
const exec = promisify(execFile),
	root = "/state/g",
	repo = `${root}/repo`,
	other = `${root}/other`;
const { RuntimeClient } = await import(pathToFileURL(join(dirname(entry), "client.mjs")).href);
const socketPath = `${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`;
const git = async (cwd, ...args) => (await exec("git", args, { cwd })).stdout.trim();
const cli = async (command) =>
	JSON.parse(
		(
			await exec(process.execPath, [entry, command, "--root", root], {
				timeout: 45000,
				env: { ...process.env, GIT_DIR: `${other}/.git`, GIT_WORK_TREE: other },
			})
		).stdout,
	);
const until = async (check, label) => {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out: ${label}`);
};
await mkdir(`${root}/agent`, { recursive: true, mode: 0o700 });
await mkdir(`${root}/template`);
for (const path of [repo, other]) {
	await mkdir(path);
	await git(path, "init", "-q", "-b", "main", `--template=${root}/template`);
	await git(path, "config", "user.name", "Isolated fixture");
	await git(path, "config", "user.email", "fixture@example.invalid");
	await writeFile(`${path}/file.txt`, "MAIN");
	await git(path, "add", "file.txt");
	await git(path, "commit", "-qm", "Initial fixture");
	await git(path, "checkout", "-qb", "feature");
	await writeFile(`${path}/file.txt`, "FEATURE");
	await git(path, "commit", "-qam", "Feature fixture");
	await git(path, "checkout", "-q", "main");
	assert.equal(await git(path, "rev-parse", "--show-toplevel"), path);
}
let client, socket;
try {
	const started = await cli("start");
	socket = connect(socketPath);
	await new Promise((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const results = [];
	let pending = "";
	socket.on("data", (chunk) => {
		pending += chunk;
		for (;;) {
			const end = pending.indexOf("\n");
			if (end < 0) break;
			const line = pending.slice(0, end);
			pending = pending.slice(end + 1);
			const frame = JSON.parse(line);
			if (frame.id?.startsWith("proof-")) results.push(frame);
		}
	});
	client = RuntimeClient.fromStream(socket);
	const attached = await client.attach("git-fixture");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	const request = {
		type: "invoke",
		id: "proof-checkout",
		instanceId: started.instanceId,
		epoch: attached.epoch,
		method: "checkoutBranch",
		args: { cwd: repo, branch: "feature" },
		mutationSeq: 1,
	};
	socket.write(`${JSON.stringify(request)}\n`);
	await until(() => Promise.resolve(results.length === 1), "checkout completed");
	assert.equal(results[0].result, "feature");
	const reflog = await git(repo, "reflog", "--format=%H %gs");
	socket.write(`${JSON.stringify({ ...request, id: "proof-repeat" })}\n`);
	await until(() => Promise.resolve(results.length === 2), "duplicate receipt");
	assert.equal(await git(repo, "reflog", "--format=%H %gs"), reflog);
	// Drop application confirmation of a second mutation and reconnect read-only to inspect its original receipt.
	socket.write(
		`${JSON.stringify({ ...request, id: "lost-confirmation", args: { cwd: repo, branch: "main" }, mutationSeq: 2 })}\n`,
	);
	await until(
		async () => (await git(repo, "branch", "--show-current")) === "main",
		"checkout side effect before reconnect",
	);
	client.close();
	client = undefined;
	client = await RuntimeClient.connect(socketPath);
	await until(async () => !(await client.inspect()).controller, "old controller detached");
	await client.attach("git-reconnect");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	let receipt;
	await until(async () => {
		receipt = await client.queryReceipt({
			instanceId: started.instanceId,
			epoch: attached.epoch,
			sequence: 2,
		});
		return receipt.state === "succeeded";
	}, "original mutation receipt");
	assert.equal(receipt.result, "main");
	assert.equal(await git(other, "branch", "--show-current"), "main");
	assert.equal(await readFile(`${other}/file.txt`, "utf8"), "MAIN");
	await writeFile(`${repo}/file.txt`, "DIRTY");
	await assert.rejects(
		client.invoke("checkoutBranch", { cwd: repo, branch: "feature" }),
		/overwritten|local changes/i,
	);
	assert.equal(await readFile(`${repo}/file.txt`, "utf8"), "DIRTY");
	await writeFile(`${repo}/file.txt`, "MAIN");
	await writeFile(`${repo}/.git/index.lock`, "fixture lock");
	await assert.rejects(client.invoke("checkoutBranch", { cwd: repo, branch: "feature" }), /index.lock/);
	assert.equal(await readFile(`${repo}/.git/index.lock`, "utf8"), "fixture lock");
	await rm(`${repo}/.git/index.lock`);
	await assert.rejects(client.invoke("checkoutBranch", { cwd: repo, branch: "--detach" }), /Invalid/);
	assert.equal(await git(repo, "branch", "--show-current"), "main");
	client.close();
	client = undefined;
	assert.equal((await cli("stop")).stopped, true);
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			targetRepositoryOnly: true,
			duplicateDoesNotCheckoutAgain: true,
			lostConfirmationReceiptChecked: true,
			dirtyWorkAndLocksPreserved: true,
			optionInjectionRejected: true,
		}),
	);
} finally {
	client?.close();
	socket?.destroy();
	await cli("stop").catch(() => {});
}
