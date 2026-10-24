/** Disposable Linux fixture only. /work is read-only; all runtime/model data belongs to /state/i. */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || !entry?.startsWith("/work/"))
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
		messages = await client.invoke("getSessionMessages", { sessionId: session.sessionId });
		if (
			JSON.stringify(messages).includes("REMOTE_IMAGES_COMPLETE") &&
			!(await client.invoke("getStats", { sessionId: session.sessionId })).streaming
		)
			break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (!modelSawImages || !JSON.stringify(messages).includes("REMOTE_IMAGES_COMPLETE"))
		throw new Error("Image task did not complete");
	const shown = events.find((payload) => payload.event.toolName === "show_image")?.event.result?.details
		?.images;
	if (shown?.length !== 2 || shown.some((image) => image.data !== png.toString("base64")))
		throw new Error("show_image lost image bytes");
	const read = events.find((payload) => payload.event.toolName === "read")?.event.result?.content;
	if (!read?.some((item) => item.type === "image" && item.data))
		throw new Error("read image event did not arrive");
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			inputBytes: png.length * 2,
			historyBytes: Buffer.byteLength(JSON.stringify(messages)),
			durationMs: Math.round(performance.now() - start),
			clientRssDeltaMiB: Math.round((process.memoryUsage().rss - rssBefore) / 1048576),
			serverRssKiB: Number((await readFile(`/proc/${info.pid}/status`, "utf8")).match(/VmRSS:\s+(\d+)/)?.[1]),
			showImageCount: shown.length,
			readImage: true,
		}),
	);
} finally {
	client?.close();
	await new Promise((resolve) => model.close(resolve));
	try {
		await cli("stop");
	} catch {}
}
