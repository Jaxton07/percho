/** Disposable Linux container only: /work read-only and private /state/t tmpfs. Never use real credentials. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || !(entry?.startsWith("/work/") || entry?.startsWith("/runtime/")))
	throw new Error("Isolated Linux fixture required");
const exec = promisify(execFile),
	root = "/state/t";
const { RuntimeClient } = await import(pathToFileURL(join(dirname(entry), "client.mjs")).href);
const socket = `${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`;
const cli = async (...args) =>
	(await exec(process.execPath, [entry, ...args, "--root", root], { timeout: 45000 })).stdout;
const until = async (check, label) => {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error(`Timed out: ${label}`);
};
const fakeKey = "isolated-remote-settings-test-value",
	cliSentinel = JSON.stringify({ openai: { type: "api_key", key: "isolated-existing-cli-test-value" } });
await mkdir("/root/.pi/agent", { recursive: true, mode: 0o700 });
await writeFile("/root/.pi/agent/auth.json", cliSentinel, { mode: 0o600 });
await mkdir(`${root}/agent`, { recursive: true, mode: 0o700 });
let usedRemoteCredential = false;
const model = createServer(async (request, response) => {
	for await (const _chunk of request) {
	}
	usedRemoteCredential = request.headers.authorization === `Bearer ${fakeKey}`;
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	response.write(
		`data: ${JSON.stringify({ id: "settings-test", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
	);
	response.write(
		`data: ${JSON.stringify({ id: "settings-test", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
	);
	response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
let client, maintenance, authChild, maintenanceInput;
try {
	await cli("start");
	client = await RuntimeClient.connect(socket);
	await client.attach("settings-fixture");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	const providers = await client.invoke("listProviders", { options: { forceNetwork: false } });
	assert.equal(providers.find((provider) => provider.id === "openai")?.configured, false);
	await client.invoke("addCustomProvider", {
		input: {
			id: "remote-settings",
			name: "Remote settings",
			baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
			api: "openai-completions",
			models: [{ id: "m", name: "Remote settings model", contextWindow: 32000, maxTokens: 1024 }],
			apiKey: fakeKey,
		},
	});
	assert.equal(
		(await client.invoke("testProvider", { providerId: "remote-settings", modelId: "m" })).ok,
		true,
	);
	assert.equal(usedRemoteCredential, true);
	assert.equal((await stat(`${root}/agent/auth.json`)).mode & 0o777, 0o600);
	assert.equal(JSON.parse(await readFile(`${root}/agent/auth.json`, "utf8"))["remote-settings"].key, fakeKey);
	assert.equal(await readFile("/root/.pi/agent/auth.json", "utf8"), cliSentinel);
	await assert.rejects(
		client.invoke("startProviderLogin", { loginId: "unsupported", providerId: "openai" }),
		/maintenance/,
	);
	await assert.rejects(cli("auth", "--help"), /AUTH_OWNER_BUSY/);
	await client.stop();
	client.close();
	client = undefined;
	assert.equal(JSON.parse(await cli("wait-stopped")).stopped, true);
	const help = await cli("auth", "--help");
	assert.match(help, /Usage:|--provider/);
	// The verifier owns this input independently: killing the ChildProcess must not close stdin and let the SDK CLI exit before the lock assertion.
	await exec("mkfifo", [`${root}/maintenance-input`]);
	maintenanceInput = await open(`${root}/maintenance-input`, constants.O_RDWR);
	maintenance = spawn(process.execPath, [entry, "auth", "--root", root], {
		stdio: [maintenanceInput.fd, "ignore", "ignore"],
		env: {
			...process.env,
			PERCHO_AUTH_READY_FILE: `${root}/maintenance-ready`,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${new URL("./fixtures/remote-runtime-auth-ready.mjs", import.meta.url).href}`,
		},
	});
	maintenance.on("error", () => {});
	await until(async () => {
		try {
			const child = Number(await readFile(`${root}/maintenance-ready`, "utf8"));
			if (
				Number.isInteger(child) &&
				child > 0 &&
				(await readlink(`/proc/${child}/fd/3`)).endsWith("owner.lock")
			) {
				authChild = child;
				return true;
			}
		} catch {}
		return false;
	}, "maintenance child inherited lifetime owner fd");
	const parentExit = new Promise((resolve) => maintenance.once("exit", resolve));
	maintenance.kill("SIGKILL");
	await parentExit;
	assert.ok((await readlink(`/proc/${authChild}/fd/3`)).endsWith("owner.lock"));
	await assert.rejects(exec("flock", ["-n", `${root}/run/owner.lock`, "true"]));
	await assert.rejects(cli("start"), /owner is active/);
	process.kill(authChild, "SIGTERM");
	await until(async () => {
		try {
			await access(`/proc/${authChild}/fd/3`);
			return false;
		} catch {
			return true;
		}
	}, "maintenance child exited");
	authChild = undefined;
	maintenance = undefined;
	assert.equal(JSON.parse(await cli("wait-stopped")).stopped, true);
	const logs = await readFile(`${root}/logs/runtime.log`, "utf8");
	assert.equal(logs.includes(fakeKey), false);
	assert.equal(await readFile("/root/.pi/agent/auth.json", "utf8"), cliSentinel);
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			remoteCredentialUsed: true,
			existingCliUnchanged: true,
			authModePrivate: true,
			remoteDesktopLoginRejected: true,
			sameSdkMaintenanceExecutable: true,
			maintenanceSurvivesParentWithOwnerLock: true,
			noCredentialInLogs: true,
		}),
	);
} finally {
	await maintenanceInput?.close();
	client?.close();
	maintenance?.kill();
	if (authChild)
		try {
			process.kill(authChild, "SIGTERM");
		} catch {}
	await cli("stop").catch(() => {});
	model.closeAllConnections();
	await new Promise((resolve) => model.close(resolve));
}
