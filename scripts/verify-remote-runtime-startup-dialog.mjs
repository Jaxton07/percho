/** Actual standalone Linux artifact only. No model network or formal user data. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || entry !== "/runtime/entry.mjs")
	throw new Error("Isolated artifact fixture required");
const { RuntimeClient } = await import(pathToFileURL(join(dirname(entry), "client.mjs")).href);
const exec = promisify(execFile),
	root = "/state/startup",
	cwd = "/state/startup-project";
await mkdir(`${root}/agent/extensions`, { recursive: true, mode: 0o700 });
await mkdir(cwd, { recursive: true });
await writeFile(
	`${root}/agent/extensions/startup.ts`,
	`import {appendFileSync} from 'node:fs';export default pi=>{pi.on('session_start',async(_event,ctx)=>{appendFileSync('${root}/entered','1');const value=await ctx.ui.input('STARTUP_DIALOG');appendFileSync('${root}/answers',String(value)+'\\n');});};`,
);
await writeFile(
	`${root}/agent/models.json`,
	JSON.stringify({
		providers: {
			isolated: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				apiKey: "isolated-unused",
				models: [
					{
						id: "m",
						name: "m",
						contextWindow: 32000,
						maxTokens: 2048,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
const cli = async (command) =>
	JSON.parse((await exec(process.execPath, [entry, command, "--root", root], { timeout: 45000 })).stdout);
const suffix = createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12),
	socket = `${root}/run/${suffix}.sock`;
let client, pid;
async function connect() {
	const value = await RuntimeClient.connect(socket);
	await value.attach("startup-recovery");
	await Promise.all([value.invoke("getLoadedSessions"), value.invoke("getPendingInteractions")]);
	return value;
}
try {
	pid = (await cli("start")).pid;
	client = await connect();
	let arrived;
	const request = new Promise((resolve) => (arrived = resolve));
	client.close();
	client = await RuntimeClient.connect(socket, (method, payload) => {
		if (method === "onExtensionDialogRequest") arrived(payload);
	});
	await client.attach("startup-recovery");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	const creating = client
		.invoke("createSession", { options: { cwd, provider: "isolated", modelId: "m" } })
		.catch((error) => error);
	const asked = await Promise.race([
		request,
		new Promise((_, reject) => setTimeout(() => reject(Error("No startup dialog")), 10000)),
	]);
	client.close();
	await creating;
	client = await connect();
	assert.deepEqual(await client.invoke("getLoadedSessions"), []);
	const snapshot = await client.invoke("getPendingInteractions");
	assert.equal(snapshot.dialogs.length, 1);
	assert.equal(snapshot.dialogs[0].id, asked.id);
	assert.equal(snapshot.dialogs[0].cwd, cwd);
	await client.invoke("respondExtensionDialog", { requestId: asked.id, answer: { value: "recovered" } });
	await client.invoke("respondExtensionDialog", { requestId: asked.id, answer: { value: "stale" } });
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if ((await client.invoke("getLoadedSessions")).some((item) => item.meta.sessionId === asked.sessionId))
			break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(await readFile(`${root}/answers`, "utf8"), "recovered\n");
	assert.equal((await client.invoke("getPendingInteractions")).dialogs.length, 0);
	client.close();
	client = undefined;
	process.kill(pid, "SIGKILL");
	await exec("flock", ["-w", "5", `${root}/run/owner.lock`, "true"]);
	pid = (await cli("start")).pid;
	client = await connect();
	assert.deepEqual(await client.invoke("getLoadedSessions"), []);
	assert.equal(await readFile(`${root}/entered`, "utf8"), "1");
	client.close();
	client = undefined;
	await cli("stop");
	pid = undefined;
	console.log(
		JSON.stringify({
			passed: true,
			constructionDialogRecovered: true,
			answerOnce: true,
			crashDoesNotReplay: true,
		}),
	);
} finally {
	client?.close();
	if (pid) await cli("stop").catch(() => {});
}
