/** Disposable Linux container only: /work read-only, /state writable, /state/s/run on native tmpfs. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || !entry?.startsWith("/work/"))
	throw new Error("Isolated Linux fixture required");
const exec = promisify(execFile),
	root = "/state/s";
const { RuntimeClient } = await import(pathToFileURL(join(dirname(entry), "client.mjs")).href);
const socket = `${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`;
const cli = async (command, artifact = entry) =>
	JSON.parse((await exec(process.execPath, [artifact, command, "--root", root], { timeout: 45000 })).stdout);
const exists = async (path) => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};
const until = async (check, label) => {
	const deadline = Date.now() + 25000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error(`Timed out: ${label}`);
};
await mkdir(`${root}/agent/extensions`, { recursive: true, mode: 0o700 });
for (const directory of ["shutdown-project", "shutdown-late-project"])
	await mkdir(`/state/${directory}`, { recursive: true, mode: 0o700 });
for (const name of [
	"release-create",
	"release-shutdown",
	"late-entered",
	"shutdown-entered",
	"shutdown-proof",
	"mcp-pid",
	"mcp-exit",
])
	await rm(`${root}/${name}`, { force: true });
await writeFile(
	`${root}/fixture-mcp.mjs`,
	`import{writeFileSync}from'node:fs';writeFileSync('${root}/mcp-pid',String(process.pid));process.on('exit',()=>writeFileSync('${root}/mcp-exit','closed'));await import('/work/scripts/fixtures/remote-runtime-mcp.mjs');`,
);
await writeFile(
	`${root}/agent/mcp.json`,
	JSON.stringify({
		mcpServers: {
			managed: { command: process.execPath, args: [`${root}/fixture-mcp.mjs`], exposure: "direct" },
		},
	}),
);
await writeFile(
	`${root}/agent/extensions/shutdown-proof.ts`,
	`import{existsSync,writeFileSync,appendFileSync}from'node:fs';
const wait=async name=>{while(!existsSync('${root}/'+name))await new Promise(resolve=>setTimeout(resolve,20));};
export default function(pi){
 pi.on('session_start',async(_event,ctx)=>{if(ctx.cwd.endsWith('shutdown-late-project')){writeFileSync('${root}/late-entered','yes');await wait('release-create');}});
 pi.on('session_shutdown',async(_event,ctx)=>{writeFileSync('${root}/shutdown-entered','yes');await wait('release-shutdown');appendFileSync('${root}/shutdown-proof',ctx.sessionManager.getSessionId()+'\\n');});
}`,
);
let requested;
const seen = new Promise((resolve) => {
	requested = resolve;
});
const model = createServer(async (request, response) => {
	for await (const _chunk of request) {
	}
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	response.write(
		`data: ${JSON.stringify({ id: "stop-test", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "running" }, finish_reason: null }] })}\n\n`,
	);
	requested();
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
	`${root}/agent/models.json`,
	JSON.stringify({
		providers: {
			shutdown: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
				apiKey: "isolated-test-value",
				models: [
					{
						id: "m",
						name: "Shutdown fixture",
						contextWindow: 32000,
						maxTokens: 1024,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
let client, pid;
try {
	const started = await cli("start");
	pid = started.pid;
	client = await RuntimeClient.connect(socket);
	await client.attach("shutdown-fixture");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	const session = await client.invoke("createSession", {
		options: { cwd: "/state/shutdown-project", provider: "shutdown", modelId: "m" },
	});
	await until(() => exists(`${root}/mcp-pid`), "managed MCP started");
	const mcpPid = Number(await readFile(`${root}/mcp-pid`, "utf8"));
	await client.invoke("prompt", { sessionId: session.sessionId, text: "Keep streaming until stopped" });
	await seen;
	const creating = client.invoke("createSession", {
		options: { cwd: "/state/shutdown-late-project", provider: "shutdown", modelId: "m" },
	});
	const creationResult = creating.then(
		() => "unexpected success",
		(error) => error.message,
	);
	await until(() => exists(`${root}/late-entered`), "creation suspended in SDK session_start");
	await client.stop();
	await assert.rejects(client.invoke("getLoadedSessions"), /not ready|closed/);
	await assert.rejects(cli("start"), /not ready|owner|STOPPING/);
	await assert.rejects(exec("flock", ["-n", `${root}/run/owner.lock`, "true"]));
	await writeFile(`${root}/release-create`, "release");
	await until(() => exists(`${root}/shutdown-entered`), "shutdown awaits valid extension context");
	let confirmed = false;
	const stopped = cli("wait-stopped").then((result) => {
		confirmed = true;
		return result;
	});
	assert.equal(confirmed, false);
	process.kill(pid, 0);
	await assert.rejects(exec("flock", ["-n", `${root}/run/owner.lock`, "true"]));
	await writeFile(`${root}/release-shutdown`, "release");
	assert.equal((await stopped).stopped, true);
	assert.match(await creationResult, /STOPPING/);
	client.close();
	client = undefined;
	assert.equal((await readFile(`${root}/shutdown-proof`, "utf8")).trim().split("\n").length, 2);
	await until(async () => {
		try {
			return (await readFile(`/proc/${mcpPid}/stat`, "utf8")).split(" ")[2] === "Z";
		} catch {
			return true;
		}
	}, "managed MCP process exited");
	const alternate = "/state/shutdown-prepared-release";
	await mkdir(alternate, { recursive: true });
	for (const name of await readdir(dirname(entry)))
		if (name.endsWith(".mjs")) await copyFile(join(dirname(entry), name), join(alternate, name));
	if (!(await exists(join(alternate, "node_modules"))))
		await symlink("/work/node_modules", join(alternate, "node_modules"));
	const replacement = await cli("start", join(alternate, "entry.mjs"));
	assert.notEqual(replacement.instanceId, started.instanceId);
	assert.equal(replacement.environmentId, started.environmentId);
	assert.equal((await cli("stop", join(alternate, "entry.mjs"))).stopped, true);
	// A stop acceptance is insufficient: an intentionally blocked extension retains ownership past the maintenance timeout.
	await rm(`${root}/release-shutdown`, { force: true });
	await rm(`${root}/shutdown-entered`, { force: true });
	const held = await cli("start");
	pid = held.pid;
	client = await RuntimeClient.connect(socket);
	await client.attach("shutdown-timeout-fixture");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	await client.invoke("createSession", {
		options: { cwd: "/state/shutdown-project", provider: "shutdown", modelId: "m" },
	});
	await client.stop();
	await until(() => exists(`${root}/shutdown-entered`), "blocked shutdown entered");
	await assert.rejects(cli("wait-stopped"), /has not fully stopped/);
	await assert.rejects(cli("start"), /not ready|owner|STOPPING/);
	await assert.rejects(exec("flock", ["-n", `${root}/run/owner.lock`, "true"]));
	await writeFile(`${root}/release-shutdown`, "release");
	assert.equal((await cli("wait-stopped")).stopped, true);
	client.close();
	client = undefined;
	pid = undefined;
	// An incomplete prepared package must fail readiness without retaining an owner or silently selecting another package.
	const serverChunk = (await readFile(join(alternate, "cli.mjs"), "utf8")).match(
		/server-[A-Za-z0-9_-]+\.mjs/,
	)?.[0];
	assert.ok(serverChunk);
	await rm(join(alternate, serverChunk));
	await assert.rejects(cli("start", join(alternate, "entry.mjs")), /did not become ready/);
	await exec("flock", ["-n", `${root}/run/owner.lock`, "true"]);
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			activeRunAborted: true,
			lateCreationRejected: true,
			lockHeldThroughShutdown: true,
			contextsValidUntilCleanup: true,
			mcpExited: true,
			preparedReleaseStartedAfterExit: true,
			timeoutKeepsOwner: true,
			backgroundStartupFailureReleasesOwner: true,
		}),
	);
} finally {
	client?.close();
	await writeFile(`${root}/release-create`, "cleanup");
	await writeFile(`${root}/release-shutdown`, "cleanup");
	if (pid) await cli("stop").catch(() => {});
	model.closeAllConnections();
	await new Promise((resolve) => model.close(resolve));
}
