/** Disposable Linux fixture only: /work read-only, /state private test data. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || !(entry?.startsWith("/work/") || entry?.startsWith("/runtime/")))
	throw new Error("Use isolated Linux /work + /state fixture");
const { RuntimeClient } = await import(pathToFileURL(join(dirname(entry), "client.mjs")).href);
const { reduceEvent } = await import(
	pathToFileURL(process.env.PERCHO_RUNTIME_TEST_PROJECTION ?? join(dirname(entry), "recovery-projection.mjs"))
		.href
);
const exec = promisify(execFile),
	root = "/state/c",
	project = "/state/reconnect-project";
await chmod(root, 0o700);
await mkdir(`${root}/agent`, { recursive: true, mode: 0o700 });
await mkdir(project, { recursive: true });
let release,
	firstOutput,
	responded = false,
	requests = 0,
	failOnce = true;
const gate = new Promise((resolve) => (release = resolve)),
	firstSeen = new Promise((resolve) => (firstOutput = resolve));
const model = createServer(async (request, response) => {
	let body = "";
	for await (const part of request) body += part;
	const data = JSON.parse(body);
	requests++;
	const lastUser = data.messages.findLast((message) => message.role === "user");
	const text = JSON.stringify(lastUser?.content);
	if (text?.includes("FAIL_ONCE") && failOnce) {
		failOnce = false;
		response.writeHead(400, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ error: { message: "isolated forced failure" } }));
		return;
	}
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (delta, finish_reason = null) =>
		response.write(
			`data: ${JSON.stringify({ id: "reconnect", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	send({ role: "assistant" });
	if (!responded) {
		responded = true;
		send({ content: "FIRST_" });
		firstOutput();
		await gate;
		send({ content: "SECOND_DONE" });
	} else send({ content: text?.includes("FAIL_ONCE") ? "RETRIED_OK" : "COMPACT_OR_SECOND_REPLY" });
	send({}, "stop");
	response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
	`${root}/agent/models.json`,
	JSON.stringify({
		providers: {
			"reconnect-fixture": {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
				apiKey: "isolated-reconnect-test",
				models: [
					{
						id: "m",
						name: "Reconnect",
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
await writeFile(
	`${root}/agent/settings.json`,
	JSON.stringify({
		compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 128 },
		retry: { enabled: false, maxRetries: 0 },
	}),
);
const cli = async (...args) =>
	JSON.parse((await exec(process.execPath, [entry, ...args, "--root", root], { timeout: 40000 })).stdout);
const socketPath = `${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`;
const wait = async (check) => {
	const end = Date.now() + 20000;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Fixture timed out");
};
let client, socket;
const events = [];
const onEvent = (method, payload) => {
	if (method === "onEvent") events.push(payload);
};
try {
	const runtimeInfo = await cli("start");
	client = await RuntimeClient.connect(socketPath, onEvent);
	await client.attach("before-loss");
	let refused = false;
	try {
		await client.invoke("createSession", { options: { cwd: project } });
	} catch (error) {
		if (error.code !== "NOT_EXECUTED") throw error;
		refused = true;
	}
	if (!refused || (await client.invoke("getLoadedSessions")).length !== 0)
		throw new Error("New work was admitted before initial synchronization");
	await client.invoke("getPendingInteractions");
	const session = await client.invoke("createSession", {
		options: { cwd: project, provider: "reconnect-fixture", modelId: "m", thinkingLevel: "off" },
	});
	const empty = await client.invoke("createSession", {
		options: { cwd: project, provider: "reconnect-fixture", modelId: "m", thinkingLevel: "off" },
	});
	try {
		await access(empty.sessionFile);
		throw new Error("Empty session unexpectedly persisted");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const image = (await readFile("/state/image-project/noise.png")).toString("base64");
	await client.invoke("prompt", {
		sessionId: session.sessionId,
		text: "LIVE_RECONNECT",
		images: [
			{ data: image, mimeType: "image/png" },
			{ data: image, mimeType: "image/png" },
		],
	});
	await firstSeen;
	await wait(() => events.some((item) => JSON.stringify(item.event).includes("FIRST_")));
	client.close();
	client = undefined;
	const end = Date.now() + 3000;
	while (Date.now() < end) {
		client = await RuntimeClient.connect(socketPath, onEvent);
		try {
			await client.attach("after-loss");
			break;
		} catch (error) {
			client.close();
			client = undefined;
			if (error.code !== "BUSY") throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	if (!client) throw new Error("Controller was not released");
	const loaded = await client.invoke("getLoadedSessions");
	await client.invoke("getPendingInteractions");
	if (
		!loaded.some((item) => item.meta.sessionId === empty.sessionId && item.meta.messageCount === 0) ||
		!loaded.find((item) => item.meta.sessionId === session.sessionId)?.streaming
	)
		throw new Error("Live/zero-message registry was not restored");
	// Capture FIRST_ before releasing the model; release on the first large response chunk.
	client.close();
	client = undefined;
	await new Promise((resolve) => setTimeout(resolve, 30));
	socket = connect(socketPath);
	await new Promise((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	client = RuntimeClient.fromStream(socket, onEvent);
	await client.attach("during-large-baseline");
	await client.invoke("getLoadedSessions");
	await client.invoke("getPendingInteractions");
	let started = false;
	const releaseDuringTransfer = (bytes) => {
		if (!started && bytes.toString("utf8").includes('"type":"chunk"')) {
			started = true;
			release();
		}
	};
	socket.on("data", releaseDuringTransfer);
	const before = performance.now(),
		rss = process.memoryUsage().rss;
	const baseline = await client.invoke("getSessionBaseline", { sessionId: session.sessionId });
	socket.off("data", releaseDuringTransfer);
	if (!started || baseline.transcript.streaming?.text !== "FIRST_")
		throw new Error("Baseline was not captured before concurrent output");
	await wait(() =>
		events.some((item) => item.sessionId === session.sessionId && item.event.type === "agent_settled"),
	);
	let projected = baseline.transcript;
	for (const event of events.filter(
		(item) => item.sessionId === session.sessionId && item.sequence > baseline.sequence,
	))
		projected = reduceEvent(projected, event.event);
	if (
		projected.messages.filter((message) => message.text === "FIRST_SECOND_DONE").length !== 1 ||
		projected.agentActive
	)
		throw new Error("Baseline/increments duplicated or lost output");
	const settledCount = () =>
		events.filter((item) => item.sessionId === session.sessionId && item.event.type === "agent_settled")
			.length;
	let count;
	for (let turn = 0; turn < 4; turn++) {
		count = settledCount();
		await client.invoke("prompt", {
			sessionId: session.sessionId,
			text: `SECOND_TURN_${turn} ${"fixture-context ".repeat(600)}`,
		});
		await wait(() => settledCount() > count);
	}
	await client.invoke("compact", { sessionId: session.sessionId });
	const compacted = await client.invoke("getSessionBaseline", { sessionId: session.sessionId });
	if (
		!compacted.transcript.messages.some(
			(message) => message.kind === "system" && message.compact?.status === "done",
		) ||
		!compacted.transcript.messages.some((message) => message.text === "LIVE_RECONNECT")
	)
		throw new Error("Compaction replaced complete branch history");
	const fork = await client.invoke("forkSession", {
		sessionId: session.sessionId,
		ref: { text: "FIRST_SECOND_DONE" },
	});
	const forked = await client.invoke("getSessionBaseline", { sessionId: fork.sessionId });
	if (
		!forked.transcript.messages.some((message) => message.text === "FIRST_SECOND_DONE") ||
		forked.transcript.messages.some((message) => message.text?.startsWith("SECOND_TURN"))
	)
		throw new Error("Fork baseline used wrong branch");
	await client.invoke("recallMessage", { sessionId: fork.sessionId, ref: { text: "LIVE_RECONNECT" } });
	if ((await client.invoke("getSessionBaseline", { sessionId: fork.sessionId })).transcript.messages.length)
		throw new Error("Recall baseline retained detached branch");
	count = settledCount();
	await client.invoke("prompt", { sessionId: session.sessionId, text: "FAIL_ONCE" });
	await wait(() => settledCount() > count);
	const history = await client.invoke("getSessionMessages", { sessionId: session.sessionId });
	const failed = history.findLast((message) => message.stopReason === "error");
	if (!failed?.entryId) throw new Error("No authoritative failed round");
	count = settledCount();
	await client.invoke("retryLastFailedTurn", {
		sessionId: session.sessionId,
		ref: { timestamp: failed.timestamp, entryId: failed.entryId },
	});
	await wait(() => settledCount() > count);
	if (
		!(await client.invoke("getSessionBaseline", { sessionId: session.sessionId })).transcript.messages.some(
			(message) => message.text === "RETRIED_OK",
		)
	)
		throw new Error("SDK retry baseline missing");
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			zeroMessageRegistry: true,
			concurrentBaseline: true,
			baselineBytes: Buffer.byteLength(JSON.stringify(baseline)),
			durationMs: Math.round(performance.now() - before),
			clientRssDeltaMiB: Math.round((process.memoryUsage().rss - rss) / 1048576),
			clientPeakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024),
			serverPeakRssMiB: Math.ceil(
				Number((await readFile(`/proc/${runtimeInfo.pid}/status`, "utf8")).match(/VmHWM:\s+(\d+)/)?.[1]) /
					1024,
			),
			compaction: true,
			fork: true,
			recall: true,
			retry: true,
			requests,
		}),
	);
} finally {
	release();
	client?.close();
	socket?.destroy();
	await new Promise((resolve) => model.close(resolve));
	try {
		await cli("stop");
	} catch {}
}
