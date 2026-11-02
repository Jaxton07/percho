/** Disposable Linux fixture only. /work is read-only; all runtime/model data belongs to /state/i. */
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || !(entry?.startsWith("/work/") || entry?.startsWith("/runtime/")))
	throw new Error("Use the isolated Linux /work + /state fixture");
const { RuntimeClient } = await import(pathToFileURL(join(dirname(entry), "client.mjs")).href);
const exec = promisify(execFile),
	root = "/state/i",
	project = "/state/image-project";
await chmod(root, 0o700);
await mkdir(`${root}/agent`, { recursive: true, mode: 0o700 });
await mkdir(project, { recursive: true });
function crc(bytes) {
	let sum = 0xffffffff;
	for (const byte of bytes) {
		sum ^= byte;
		for (let i = 0; i < 8; i++) sum = (sum >>> 1) ^ (sum & 1 ? 0xedb88320 : 0);
	}
	return (sum ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
	const type = Buffer.from(name),
		out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length);
	type.copy(out, 4);
	data.copy(out, 8);
	out.writeUInt32BE(crc(Buffer.concat([type, data])), out.length - 4);
	return out;
}
const width = 768,
	pixels = Buffer.alloc((width * 3 + 1) * width);
for (let y = 0; y < width; y++) randomBytes(width * 3).copy(pixels, y * (width * 3 + 1) + 1);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width);
ihdr.writeUInt32BE(width, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
	Buffer.from("89504e470d0a1a0a", "hex"),
	chunk("IHDR", ihdr),
	chunk("IDAT", deflateSync(pixels)),
	chunk("IEND", Buffer.alloc(0)),
]);
await writeFile(`${project}/noise.png`, png);
let modelSawImages = false,
	modelSawRead = false,
	modelError;
const model = createServer(async (request, response) => {
	try {
		let body = "";
		for await (const part of request) body += part;
		const parsed = JSON.parse(body);
		const user = parsed.messages.find((message) => message.role === "user");
		if (
			!Array.isArray(user?.content) ||
			user.content.filter((part) => part.type === "image_url").length !== 2
		)
			throw new Error("Model did not receive both images");
		const expectedUrl = `data:image/png;base64,${png.toString("base64")}`;
		if (
			user.content
				.filter((part) => part.type === "image_url")
				.some((part) => part.image_url?.url !== expectedUrl)
		)
			throw new Error("Input images were transformed");
		if (parsed.messages.some((message) => message.role === "tool")) {
			const images = parsed.messages.flatMap((message) =>
				Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url") : [],
			);
			if (images.length !== 3 || images.some((part) => part.image_url?.url !== expectedUrl))
				throw new Error("read lost original bytes or display-only images leaked to the model");
			if (JSON.stringify(parsed).includes(createHash("sha256").update(png).digest("hex")))
				throw new Error("Display asset locator leaked to the model");
			modelSawRead = true;
		}
		modelSawImages = true;
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const send = (delta, finish_reason = null) =>
			response.write(
				`data: ${JSON.stringify({ id: "images", object: "chat.completion.chunk", created: 1, model: "images", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
			);
		send({ role: "assistant" });
		if (!parsed.messages.some((message) => message.role === "tool")) {
			send({
				tool_calls: [
					{
						index: 0,
						id: "read-image",
						type: "function",
						function: { name: "read", arguments: JSON.stringify({ path: `${project}/noise.png` }) },
					},
					{
						index: 1,
						id: "show-images",
						type: "function",
						function: {
							name: "show_image",
							arguments: JSON.stringify({ paths: [`${project}/noise.png`, `${project}/noise.png`] }),
						},
					},
				],
			});
			send({}, "tool_calls");
		} else {
			send({ content: "REMOTE_IMAGES_COMPLETE" });
			send({}, "stop");
		}
		response.end("data: [DONE]\n\n");
	} catch (error) {
		modelError = error;
		response.writeHead(500);
		response.end(String(error));
	}
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
	`${root}/agent/models.json`,
	JSON.stringify({
		providers: {
			"image-fixture": {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
				apiKey: "isolated-image-test",
				models: [
					{
						id: "images",
						name: "Image fixture",
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
let client;
async function verifyMaintenance(session, socket, initialInstance) {
	await client.invoke("closeSession", { sessionId: session.sessionId });
	const source = (await readFile(session.sessionFile, "utf8")).trimEnd().split("\n");
	const owner = randomUUID(),
		file = join(dirname(session.sessionFile), `maintenance-${owner}.jsonl`);
	const legacy = source.map((line) => {
		const entry = JSON.parse(line);
		if (entry.type === "session") entry.id = owner;
		if (
			entry.type === "message" &&
			entry.message?.role === "toolResult" &&
			entry.message.toolName === "show_image"
		)
			entry.message.details.images = [
				{ data: png.toString("base64"), mimeType: "image/png" },
				{ data: png.toString("base64"), mimeType: "image/png" },
			];
		return JSON.stringify(entry);
	});
	legacy.push("", "invalid legacy line kept verbatim");
	const original = Buffer.from(legacy.join("\n") + "\n"),
		hash = createHash("sha256").update(original).digest("hex");
	await writeFile(file, original, { mode: 0o600, flag: "wx" });
	const queries = [],
		poll = async (job) => {
			const deadline = performance.now() + 40000;
			while (["queued", "running", "cancelling"].includes(job.status)) {
				if (performance.now() > deadline) throw new Error("Linux maintenance worker timed out");
				await new Promise((resolve) => setTimeout(resolve, 15));
				const started = performance.now();
				job = await client.invoke("getSessionMediaJob", { jobId: job.jobId });
				queries.push(performance.now() - started);
			}
			if (job.status !== "completed") throw new Error(job.error ?? job.status);
			return job;
		};
	const start = performance.now();
	const preview = await poll(await client.invoke("startSessionMediaPreview", { sessionFile: file }));
	if (
		preview.result.imageCount !== 2 ||
		preview.result.invalidLines !== 1 ||
		preview.result.sourceHash !== hash ||
		!original.equals(await readFile(file))
	)
		throw new Error("Linux worker preview changed data or counts");
	const requestId = randomUUID(),
		compactStart = performance.now();
	const job = await client.invoke("startSessionMediaCompaction", {
		sessionFile: file,
		requestId,
		expectedHash: hash,
		confirmed: true,
	});
	const startMilliseconds = performance.now() - compactStart;
	client.close();
	client = await RuntimeClient.connect(socket, () => {});
	await client.attach("maintenance-reconnected");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	const complete = await poll(await client.invoke("getSessionMediaJob", { jobId: job.jobId }));
	const transactionMilliseconds = performance.now() - compactStart;
	let controlledSlowIo = false;
	if (process.env.PERCHO_MEDIA_SLOW_TEST === "1") {
		const proof = JSON.parse(await readFile("/state/slow-worker.json", "utf8"));
		if (proof.kind !== "prepare" || proof.delayMs !== 32000 || transactionMilliseconds < 32000)
			throw new Error("Actual Linux worker did not execute the controlled slow IO checkpoint");
		controlledSlowIo = true;
	}
	if (
		complete.transaction?.phase !== "complete" ||
		!original.equals(await readFile(complete.transaction.backup))
	)
		throw new Error("Linux compaction backup/receipt mismatch");
	const candidate = await readFile(file, "utf8");
	for (const line of legacy) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			if (line && !candidate.includes(line)) throw new Error("Bad line disappeared");
			continue;
		}
		if (
			entry.type === "message" &&
			(entry.message?.role === "user" || entry.message?.toolName === "read") &&
			!candidate.includes(line)
		)
			throw new Error("Input/read line was rewritten");
	}
	client.close();
	await cli("stop");
	const restarted = await cli("start");
	if (restarted.instanceId === initialInstance) throw new Error("Daemon restart did not change instance");
	client = await RuntimeClient.connect(socket, () => {});
	await client.attach("maintenance-restarted");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	const transaction = await client.invoke("getSessionMediaTransaction", { requestId });
	if (
		transaction?.phase !== "complete" ||
		transaction.outputHash !== createHash("sha256").update(candidate).digest("hex")
	)
		throw new Error("Restart lost the durable receipt");
	const replay = await client.invoke("startSessionMediaCompaction", {
		sessionFile: file,
		requestId,
		expectedHash: hash,
		confirmed: true,
	});
	if (
		replay.transaction?.operationId !== transaction.operationId ||
		(await readFile(file, "utf8")) !== candidate
	)
		throw new Error("Request id replay changed published content");
	await poll(
		await client.invoke("startSessionMediaRestore", {
			requestId: randomUUID(),
			compactionRequestId: requestId,
			confirmed: true,
		}),
	);
	if (!original.equals(await readFile(file))) throw new Error("Linux restore was not byte-identical");
	return {
		previewWorker: true,
		controlledSlowIo,
		transactionMilliseconds: Math.round(transactionMilliseconds),
		originalBytes: original.length,
		compactedBytes: Buffer.byteLength(candidate),
		startMilliseconds: Math.round(startMilliseconds * 100) / 100,
		maxQueryMilliseconds: Math.round(Math.max(0, ...queries) * 100) / 100,
		detachedCompletion: true,
		durableAfterDaemonRestart: true,
		sameRequestIdNotReapplied: true,
		inputReadAndBadLinesUnchanged: true,
		restoreByteIdentical: true,
		durationMs: Math.round(performance.now() - start),
	};
}
const start = performance.now(),
	rssBefore = process.memoryUsage().rss;
try {
	const info = await cli("start");
	const socket = `${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`;
	const events = [];
	client = await RuntimeClient.connect(socket, (method, payload) => {
		if (method === "onEvent" && payload.event.type === "tool_execution_end") events.push(payload);
	});
	await client.attach("image-fixture");
	await client.invoke("getLoadedSessions");
	await client.invoke("getPendingInteractions");
	const session = await client.invoke("createSession", {
		options: { cwd: project, provider: "image-fixture", modelId: "images", thinkingLevel: "off" },
	});
	await client.invoke("setPermissionMode", { sessionId: session.sessionId, mode: "fullAccess" });
	await client.invoke("prompt", {
		sessionId: session.sessionId,
		text: "Read and display these two images",
		images: [
			{ data: png.toString("base64"), mimeType: "image/png" },
			{ data: png.toString("base64"), mimeType: "image/png" },
		],
	});
	let messages;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (modelError) throw modelError;
		messages = await client.invoke("getSessionMessages", {
			sessionId: session.sessionId,
			imageMode: "references",
		});
		if (
			JSON.stringify(messages).includes("REMOTE_IMAGES_COMPLETE") &&
			!(await client.invoke("getStats", { sessionId: session.sessionId })).streaming
		)
			break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (!modelSawImages || !modelSawRead || !JSON.stringify(messages).includes("REMOTE_IMAGES_COMPLETE"))
		throw new Error("Image task did not complete");
	const shown = events.find((payload) => payload.event.toolName === "show_image")?.event.result?.details
		?.images;
	if (shown?.length !== 2 || shown.some((image) => image.kind !== "reference" || image.data))
		throw new Error("show_image did not publish lightweight display references");
	const baseline = await client.invoke("getSessionBaseline", {
		sessionId: session.sessionId,
		imageMode: "references",
		historyTurns: 4,
	});
	const displayed = baseline.transcript.messages.find(
		(message) => message.kind === "image" && message.images.length === 2,
	);
	if (!displayed || displayed.images.some((image) => image.kind !== "reference"))
		throw new Error("Displayed images missing from the authoritative baseline");
	const sourceBefore = createHash("sha256")
		.update(await readFile(session.sessionFile))
		.digest("hex");
	await rm(`${project}/noise.png`); // 只读图按资产/entry来源，不回读原始工作区路径。
	for (const image of displayed.images) {
		const original = await client.invoke("getSessionImage", {
			sessionId: image.ownerSessionId,
			imageId: image.id,
			revision: image.revision,
		});
		if (original.data !== png.toString("base64"))
			throw new Error("Reference lookup lost original image bytes");
	}
	let denied = false;
	try {
		await client.invoke("getSessionImage", {
			sessionId: session.sessionId,
			imageId: `${project}/noise.png`,
			revision: displayed.images[0].revision,
		});
	} catch {
		denied = true;
	}
	if (!denied) throw new Error("Path-shaped image locator was accepted");
	if (
		createHash("sha256")
			.update(await readFile(session.sessionFile))
			.digest("hex") !== sourceBefore
	)
		throw new Error("History/image reads rewrote the source");
	const legacy = await client.invoke("getSessionMessages", { sessionId: session.sessionId });
	const userImages = legacy.find((message) => message.role === "user")?.images;
	if (userImages?.length !== 2 || userImages.some((image) => image.data !== png.toString("base64")))
		throw new Error("Full-mode input image compatibility changed");
	if (Buffer.byteLength(JSON.stringify(baseline)) > 256 * 1024)
		throw new Error("Standard image baseline exceeds its page budget");
	const read = events.find((payload) => payload.event.toolName === "read")?.event.result?.content;
	if (!read?.some((item) => item.type === "image")) throw new Error("read image event did not arrive");
	await writeFile(`${project}/noise.png`, png, { mode: 0o600 }); // 后续离线验包场景复用该合成文件；删除期间已完成资产字节验证。
	const maintenance = await verifyMaintenance(session, socket, info.instanceId);
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			maintenance,
			inputBytes: png.length * 2,
			historyBytes: Buffer.byteLength(JSON.stringify(messages)),
			durationMs: Math.round(performance.now() - start),
			clientRssDeltaMiB: Math.round((process.memoryUsage().rss - rssBefore) / 1048576),
			serverRssKiB: Number(
				(await readFile(`/proc/${(await cli("status")).pid}/status`, "utf8")).match(/VmRSS:\s+(\d+)/)?.[1],
			),
			showImageCount: shown.length,
			readImage: true,
			displayReferences: true,
			originalImageBytesVerified: true,
			modelInputAndReadUnchanged: modelSawRead,
			displayImagesNotInModel: true,
			baselineBytes: Buffer.byteLength(JSON.stringify(baseline)),
			fullModeInputCompatibility: true,
			pathRejected: true,
			sourceUnchanged: true,
		}),
	);
} finally {
	client?.close();
	await new Promise((resolve) => model.close(resolve));
	try {
		await cli("stop");
	} catch {}
}
