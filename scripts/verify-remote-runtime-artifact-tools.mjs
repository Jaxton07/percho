/** Standalone package in /runtime, disposable Linux container, private /state/a. No checkout dependencies. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || entry !== "/runtime/entry.mjs")
	throw new Error("Standalone Linux fixture required");
const { RuntimeClient } = await import("/runtime/client.mjs");
const manifest = JSON.parse(await readFile("/runtime/package.json", "utf8"));
const exec = promisify(execFile),
	root = "/state/a",
	cwd = "/state/artifact-project";
await mkdir(`${root}/agent/extensions`, { recursive: true, mode: 0o700 });
await mkdir(cwd, { recursive: true });
await writeFile(
	`${root}/agent/extensions/active-tools.ts`,
	"export default function(pi){pi.on('session_start',()=>pi.setActiveTools([...new Set([...pi.getActiveTools(),'grep','find','ls','codemode'])]));}",
);
const model = createServer(async (request, response) => {
	let body = "";
	for await (const chunk of request) body += chunk;
	const data = JSON.parse(body);
	const called = data.messages
		.flatMap((message) => message.tool_calls ?? [])
		.map((call) => call.function.name);
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (delta, finish_reason = null) =>
		response.write(
			`data: ${JSON.stringify({ id: "artifact", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	send({ role: "assistant" });
	let calls;
	if (!called.includes("write"))
		calls = [
			{ name: "write", args: { path: "proof.txt", content: "ARTIFACT_ORIGINAL\n" } },
			{ name: "bash", args: { command: "printf ARTIFACT_BASH" } },
		];
	else if (!called.includes("codemode"))
		calls = [
			{ name: "edit", args: { path: "proof.txt", oldText: "ARTIFACT_ORIGINAL", newText: "ARTIFACT_EDITED" } },
			{ name: "grep", args: { pattern: "ARTIFACT", path: cwd } },
			{ name: "find", args: { pattern: "*.txt", path: cwd } },
			{ name: "ls", args: { path: cwd } },
			{ name: "read", args: { path: "proof.txt" } },
			{
				name: "codemode",
				args: { code: 'text("ARTIFACT_CODEMODE");text(await tools.read({path:"proof.txt"}));' },
			},
		];
	if (calls) {
		send({
			tool_calls: calls.map((call, index) => ({
				index,
				id: `${called.length}-${index}`,
				type: "function",
				function: { name: call.name, arguments: JSON.stringify(call.args) },
			})),
		});
		send({}, "tool_calls");
	} else {
		send({ content: "ARTIFACT_TOOLS_DONE" });
		send({}, "stop");
	}
	response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
	`${root}/agent/models.json`,
	JSON.stringify({
		providers: {
			artifact: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
				apiKey: "isolated-artifact",
				models: [
					{
						id: "m",
						name: "Artifact",
						contextWindow: 128000,
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
const cli = async (command) =>
	JSON.parse((await exec(process.execPath, [entry, command, "--root", root], { timeout: 90000 })).stdout);
let client;
try {
	const info = await cli("start");
	assert.equal(info.runtimeVersion, manifest.version);
	assert.equal(info.sdkVersion, manifest.dependencies["@earendil-works/pi-coding-agent"]);
	client = await RuntimeClient.connect(
		`${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`,
	);
	await client.attach("artifact-tools");
	await Promise.all([client.invoke("getLoadedSessions"), client.invoke("getPendingInteractions")]);
	const session = await client.invoke("createSession", {
		options: { cwd, provider: "artifact", modelId: "m", thinkingLevel: "off" },
	});
	await client.invoke("setPermissionMode", { sessionId: session.sessionId, mode: "fullAccess" });
	await client.invoke("prompt", { sessionId: session.sessionId, text: "ARTIFACT_TOOLS" });
	let messages = [];
	const deadline = Date.now() + 120000;
	while (Date.now() < deadline) {
		messages = await client.invoke("getSessionMessages", { sessionId: session.sessionId });
		if (JSON.stringify(messages).includes("ARTIFACT_TOOLS_DONE")) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.match(JSON.stringify(messages), /ARTIFACT_TOOLS_DONE/);
	const tools = messages.flatMap((message) => message.tools ?? []);
	for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls", "codemode"]) {
		const tool = tools.find((item) => item.name === name);
		assert.ok(tool, `Missing ${name}`);
		assert.ok(!tool.isError, `${name} failed: ${tool.output}`);
	}
	assert.match(tools.find((tool) => tool.name === "codemode").output, /ARTIFACT_CODEMODE/);
	assert.equal(await readFile(`${cwd}/proof.txt`, "utf8"), "ARTIFACT_EDITED\n");
	const jsonl = await client.invoke("exportSession", { sessionId: session.sessionId, format: "jsonl" });
	for (const line of jsonl.trim().split("\n")) JSON.parse(line);
	const html = await client.invoke("exportSession", { sessionId: session.sessionId, format: "html" });
	assert.match(html, /<script id="session-data"/);
	client.close();
	client = undefined;
	assert.equal((await cli("stop")).stopped, true);
	console.log(
		JSON.stringify({
			passed: true,
			arch: process.arch,
			fullFileTools: true,
			codemodeWorkerWasm: true,
			htmlAndJsonlExport: true,
		}),
	);
} finally {
	client?.close();
	await cli("stop").catch(() => {});
	await new Promise((resolve) => model.close(resolve));
}
