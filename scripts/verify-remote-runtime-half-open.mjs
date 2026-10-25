/** Real heartbeat expiry on both sides, with an actual paused daemon and a silent controller. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || entry !== "/runtime/entry.mjs")
	throw new Error("Isolated artifact required");
const { RuntimeClient } = await import("/runtime/client.mjs");
const root = "/state/half-open",
	exec = promisify(execFile);
const cli = async (command) =>
	JSON.parse((await exec(process.execPath, [entry, command, "--root", root], { timeout: 45000 })).stdout);
const socketPath = `${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`;
async function socket() {
	const value = connect(socketPath);
	await new Promise((resolve, reject) => {
		value.once("connect", resolve);
		value.once("error", reject);
	});
	return value;
}
async function closed(value) {
	let timer;
	try {
		await Promise.race([
			new Promise((resolve) => value.once("close", resolve)),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(Error("Heartbeat did not close idle transport")), 36000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
let client,
	raw,
	pid,
	paused = false;
try {
	const info = await cli("start");
	pid = info.pid;
	const transport = await socket();
	client = RuntimeClient.fromStream(transport);
	await client.attach("idle-desktop");
	const start = Date.now();
	process.kill(pid, "SIGSTOP");
	paused = true;
	await closed(transport);
	const clientMs = Date.now() - start;
	assert.ok(clientMs >= 25000 && clientMs < 36000);
	process.kill(pid, "SIGCONT");
	paused = false;
	client.close();
	client = undefined;
	raw = await socket();
	let buffer = "",
		resolveAttachment;
	const attached = new Promise((resolve) => (resolveAttachment = resolve));
	raw.on("data", (chunk) => {
		buffer += chunk;
		while (buffer.includes("\n")) {
			const index = buffer.indexOf("\n"),
				line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			const frame = JSON.parse(line);
			if (frame.id === "silent") resolveAttachment(frame.result);
		}
	});
	raw.write(
		`${JSON.stringify({ type: "attach", id: "silent", protocol: 3, clientTag: "silent-controller" })}\n`,
	);
	const attachment = await attached;
	assert.equal(attachment.info.instanceId, info.instanceId);
	client = await RuntimeClient.connect(socketPath);
	await assert.rejects(client.attach("other-desktop"), /already controlled/);
	client.close();
	client = undefined;
	const serverStart = Date.now();
	await closed(raw);
	const serverMs = Date.now() - serverStart;
	assert.ok(serverMs < 30000);
	raw = undefined;
	client = await RuntimeClient.connect(socketPath);
	const next = await client.attach("after-expiry");
	assert.equal(next.info.instanceId, info.instanceId);
	assert.ok(next.epoch > attachment.epoch);
	client.close();
	client = undefined;
	await cli("stop");
	pid = undefined;
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			idleDaemonLossDetectedMs: clientMs,
			silentControllerReleasedMs: serverMs,
			noTakeover: true,
			sameDaemon: true,
		}),
	);
} finally {
	if (paused && pid) process.kill(pid, "SIGCONT");
	client?.close();
	raw?.destroy();
	if (pid) await cli("stop").catch(() => {});
}
