/** Isolated Linux only. All projects/config/model data is private under /state/a. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || !entry?.startsWith("/work/"))
	throw new Error("Use isolated Linux /work + /state fixture");
const { RuntimeClient } = await import(pathToFileURL(join(dirname(entry), "client.mjs")).href);
const exec = promisify(execFile),
	root = "/state/a",
	project = "/state/approval-history-project";
await chmod(root, 0o700);
await mkdir(`${root}/agent/extensions`, { recursive: true, mode: 0o700 });
await mkdir(`${project}/.pi/extensions`, { recursive: true });
await Promise.all(
	[`${root}/agent/trust.json`, `${root}/agent/dialog-results.jsonl`, `${project}/permission-proof.txt`].map(
		(path) => rm(path, { force: true }),
	),
);
await writeFile(`${project}/.pi/extensions/trust-probe.ts`, "export default function(pi){}\n");
await writeFile(
	`${root}/agent/extensions/dialog-probe.ts`,
	`import {appendFileSync} from 'node:fs';export default function(pi){pi.on('before_agent_start',async(event,ctx)=>{if(!event.prompt.includes('DIALOG_'))return;ctx.ui.notify('LIVE_ONLY_NOTICE','info');ctx.ui.setEditorText('LIVE_ONLY_PREFILL');let value;const opts={timeout:event.prompt.includes('TIMEOUT')?120:5000};if(event.prompt.includes('CONFIRM'))value=await ctx.ui.confirm('fixture confirm','confirm?',opts);else if(event.prompt.includes('SELECT'))value=await ctx.ui.select('fixture select',['first','second'],opts);else if(event.prompt.includes('EDITOR'))value=await ctx.ui.editor('fixture editor','prefill');else value=await ctx.ui.input('fixture input',undefined,opts);appendFileSync(process.env.PI_CODING_AGENT_DIR+'/dialog-results.jsonl',JSON.stringify({prompt:event.prompt,value:value??null})+String.fromCharCode(10));});}`,
);
await writeFile(
	`${root}/agent/permissions.json`,
	JSON.stringify({ enabled: true, rules: { bash: { "*": "ask" } } }),
);
await writeFile(`${root}/agent/settings.json`, JSON.stringify({ defaultProjectTrust: "ask" }));
let modelRequests = 0;
const model = createServer(async (request, response) => {
	let body = "";
	for await (const part of request) body += part;
	const parsed = JSON.parse(body);
	modelRequests++;
	const user = parsed.messages.findLastIndex((message) => message.role === "user");
	const content = JSON.stringify(parsed.messages[user]?.content);
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (delta, finish_reason = null) =>
		response.write(
			`data: ${JSON.stringify({ id: "approval", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	send({ role: "assistant" });
	if (
		content?.includes("APPROVAL") &&
		!parsed.messages.slice(user + 1).some((message) => message.role === "tool")
	) {
		send({
			tool_calls: [
				{
					index: 0,
					id: `write-${modelRequests}`,
					type: "function",
					function: {
						name: "bash",
						arguments: JSON.stringify({ command: "printf 'approved\\n' >> permission-proof.txt" }),
					},
				},
			],
		});
		send({}, "tool_calls");
	} else {
		send({ content: "INTERACTION_COMPLETE" });
		send({}, "stop");
	}
	response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
	`${root}/agent/models.json`,
	JSON.stringify({
		providers: {
			"interaction-fixture": {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
				apiKey: "isolated-interaction-test",
				models: [
					{
						id: "m",
						name: "Interaction fixture",
						contextWindow: 32000,
						maxTokens: 2048,
						reasoning: false,
						input: ["text", "image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
const cli = async (...args) =>
	JSON.parse((await exec(process.execPath, [entry, ...args, "--root", root], { timeout: 40000 })).stdout);
const socket = `${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`;
const wait = async (check) => {
	const end = Date.now() + 15000;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Interaction fixture timed out");
};
let client, transport;
const events = [];
async function attach() {
	const end = Date.now() + 3000;
	while (Date.now() < end) {
		transport = connect(socket);
		await new Promise((resolve, reject) => {
			transport.once("connect", resolve);
			transport.once("error", reject);
		});
		client = RuntimeClient.fromStream(transport, (method, payload) => events.push({ method, payload }));
		try {
			await client.attach("interaction-fixture");
			await client.invoke("getLoadedSessions");
			await client.invoke("getPendingInteractions");
			return;
		} catch (error) {
			client.close();
			if (error.code !== "BUSY") throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error("Previous controller not released");
}
const snapshot = () => client.invoke("getPendingInteractions");
const settled = (id) =>
	events.filter(
		(item) =>
			item.method === "onEvent" &&
			item.payload.sessionId === id &&
			item.payload.event.type === "agent_settled",
	).length;
const pendingKind = async (kind) =>
	wait(async () => {
		const s = await snapshot();
		return s[kind][0];
	});
try {
	await cli("start");
	await attach();
	const creating = client.invoke("createSession", {
		options: { cwd: project, provider: "interaction-fixture", modelId: "m", thinkingLevel: "off" },
	});
	void creating.catch(() => {});
	const trust = await pendingKind("trust");
	client.close();
	await creating.catch(() => {});
	await attach();
	if (!(await snapshot()).trust.some((item) => item.id === trust.id))
		throw new Error("Trust request was not retained");
	await client.invoke("respondTrust", { requestId: trust.id, answer: 0 });
	await client.invoke("respondTrust", { requestId: trust.id, answer: 0 });
	const session = await wait(
		async () => (await client.invoke("getLoadedSessions")).find((item) => item.meta.cwd === project)?.meta,
	);
	const sid = session.sessionId;
	let count = settled(sid);
	const png = (await readFile("/state/image-project/noise.png")).toString("base64");
	await client.invoke("prompt", {
		sessionId: sid,
		text: "APPROVAL",
		images: [
			{ data: png, mimeType: "image/png" },
			{ data: png, mimeType: "image/png" },
		],
	});
	const permission = await pendingKind("permissions");
	client.close();
	await new Promise((resolve) => setTimeout(resolve, 150));
	try {
		await access(`${project}/permission-proof.txt`);
		throw new Error("Tool ran without approval");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	await attach();
	if (!(await snapshot()).permissions.some((item) => item.id === permission.id))
		throw new Error("Approval lost while offline");
	let pausedResolve;
	const paused = new Promise((resolve) => (pausedResolve = resolve));
	const pauseOnChunk = (bytes) => {
		if (bytes.toString("utf8").includes('"type":"chunk"')) {
			transport.pause();
			transport.off("data", pauseOnChunk);
			pausedResolve();
		}
	};
	transport.on("data", pauseOnChunk);
	let baselineComplete = false;
	const baseline = client.invoke("getSessionBaseline", { sessionId: sid }).then((value) => {
		baselineComplete = true;
		return value;
	});
	void baseline.catch(() => {});
	await paused;
	const answering = client.invoke("respondPermission", { requestId: permission.id, answer: "allow" });
	void answering.catch(() => {});
	const duplicate = client.invoke("respondPermission", { requestId: permission.id, answer: "allow" });
	void duplicate.catch(() => {});
	await wait(async () => {
		try {
			return (await readFile(`${project}/permission-proof.txt`, "utf8")) === "approved\n";
		} catch {
			return false;
		}
	});
	if (baselineComplete) throw new Error("Large baseline finished before approval proof");
	transport.resume();
	const recovered = await baseline;
	await Promise.all([answering, duplicate]);
	const baselineBytes = Buffer.byteLength(JSON.stringify(recovered));
	if (baselineBytes < 1024 * 1024) throw new Error("Fixture did not exercise large history");
	await wait(() => settled(sid) > count);
	if ((await readFile(`${project}/permission-proof.txt`, "utf8")) !== "approved\n")
		throw new Error("Duplicate approval executed file effect twice");
	for (const [label, answer] of [
		["DIALOG_INPUT", { value: "typed" }],
		["DIALOG_SELECT", { value: "second" }],
		["DIALOG_CONFIRM", { confirmed: false }],
		["DIALOG_EDITOR", { value: "edited" }],
	]) {
		count = settled(sid);
		const prompt = client.invoke("prompt", { sessionId: sid, text: label });
		void prompt.catch(() => {});
		const dialog = await pendingKind("dialogs");
		client.close();
		await prompt.catch(() => {});
		const eventOffset = events.length;
		await attach();
		const s = await snapshot();
		if (!s.dialogs.some((item) => item.id === dialog.id) || JSON.stringify(s).includes("LIVE_ONLY_"))
			throw new Error("Pending dialog/replay snapshot incorrect");
		if (
			events
				.slice(eventOffset)
				.some((item) => item.method === "onExtensionNotify" || item.method === "onExtensionEditorText")
		)
			throw new Error("Transient UI event replayed");
		await client.invoke("respondExtensionDialog", { requestId: dialog.id, answer });
		await client.invoke("respondExtensionDialog", { requestId: dialog.id, answer });
		await wait(() => settled(sid) > count);
	}
	count = settled(sid);
	const timingOut = client.invoke("prompt", { sessionId: sid, text: "DIALOG_TIMEOUT" });
	void timingOut.catch(() => {});
	const expiring = await pendingKind("dialogs");
	client.close();
	await timingOut.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 250));
	await attach();
	if ((await snapshot()).dialogs.some((item) => item.id === expiring.id))
		throw new Error("Expired dialog resurrected");
	await client.invoke("respondExtensionDialog", { requestId: expiring.id, answer: { value: "late" } });
	await wait(
		async () =>
			!(await client.invoke("getLoadedSessions")).find((item) => item.meta.sessionId === sid)?.streaming,
	);
	count = settled(sid);
	await client.invoke("prompt", { sessionId: sid, text: "APPROVAL_ABORT" });
	await pendingKind("permissions");
	await client.invoke("abort", { sessionId: sid });
	await wait(() => settled(sid) > count);
	if (
		(await snapshot()).permissions.length ||
		(await readFile(`${project}/permission-proof.txt`, "utf8")) !== "approved\n"
	)
		throw new Error("Stopped approval remained pending or executed");
	const lines = (await readFile(`${root}/agent/dialog-results.jsonl`, "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	if (
		lines.length !== 5 ||
		JSON.stringify(lines.map((item) => item.value)) !==
			JSON.stringify(["typed", "second", false, "edited", null])
	)
		throw new Error("Dialog settlement repeated or wrong values");
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			trustRestored: true,
			permissionSurvivesOffline: true,
			externalWrites: 1,
			approvalDuringLargeHistory: true,
			baselineBytes,
			dialogs: 4,
			expiredNotReplayed: true,
			abortCancelsApproval: true,
			transientUiNotReplayed: true,
		}),
	);
} finally {
	client?.close();
	await new Promise((resolve) => model.close(resolve));
	try {
		await cli("stop");
	} catch {}
}
