/** Run only in a disposable Linux container: repository at /work (read-only), isolated writable /state. */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || !entry?.startsWith("/work/"))
	throw new Error(
		"Set PERCHO_RUNTIME_TEST_ENTRY to the artifact in an isolated /work + /state Linux container",
	);
const { RuntimeClient } = await import(pathToFileURL(join(dirname(entry), "client.mjs")).href);
const root = "/state/r";
await mkdir(`${root}/agent`, { recursive: true, mode: 0o700 });
await mkdir("/state/project", { recursive: true, mode: 0o700 });
await mkdir("/state/project-two", { recursive: true, mode: 0o700 });
await mkdir(`${root}/agent/extensions`, { recursive: true, mode: 0o700 });
await mkdir(`${root}/agent/agents`, { recursive: true, mode: 0o700 });
await writeFile(
	"/state/project/AGENTS.md",
	"REMOTE_RULE_SENTINEL: this project belongs to the remote runtime.",
);
await writeFile(
	`${root}/agent/extensions/remote-proof.ts`,
	`import {writeFileSync} from 'node:fs';export default function(pi){pi.on('session_start',()=>writeFileSync(process.env.PI_CODING_AGENT_DIR+'/extension-proof','REMOTE_EXTENSION_SENTINEL'));}`,
);
await writeFile(
	`${root}/agent/agents/remote-worker.md`,
	"---\nname: remote-worker\ndescription: Verify the remote project\ntools: read\nmodel: runtime-test/m0\n---\nREMOTE_CHILD_SENTINEL: inspect the remote rules file then report.",
);
await writeFile(
	`${root}/agent/mcp.json`,
	JSON.stringify({
		mcpServers: {
			remote: {
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/remote-runtime-mcp.mjs", import.meta.url))],
				exposure: "direct",
			},
		},
	}),
);

const socket = `${root}/run/${createHash("sha256").update(`${process.getuid()}:${root}`).digest("hex").slice(0, 12)}.sock`;
const cli = async (...args) =>
	JSON.parse(
		(await exec(process.execPath, [entry, ...args, "--root", root], { timeout: 40000 })).stdout.trim(),
	);
let release;
const gate = new Promise((resolve) => (release = resolve));
let arrived;
const requestSeen = new Promise((resolve) => (arrived = resolve));
const model = createServer(async (request, response) => {
	let body = "";
	for await (const chunk of request) body += chunk;
	const parsed = JSON.parse(body);
	const child = JSON.stringify(parsed.messages).includes("REMOTE_CHILD_SENTINEL");
	if (!child) {
		arrived();
		await gate;
	}
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (delta, finish_reason = null) =>
		response.write(
			`data: ${JSON.stringify({ id: "linux-task", object: "chat.completion.chunk", created: 1, model: "m0", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	const hasResult = parsed.messages.some((message) => message.role === "tool");
	send({ role: "assistant" });
	if (!hasResult) {
		let calls;
		if (child) calls = [{ name: "read", arguments: { path: "/state/project/AGENTS.md" } }];
		else {
			if (!JSON.stringify(parsed.messages).includes("REMOTE_RULE_SENTINEL"))
				throw new Error("Remote project rules were not loaded");
			const probe = parsed.tools.find((tool) => tool.function?.name.includes("remote_probe"))?.function.name;
			if (!probe) throw new Error("Remote MCP tool was not registered");
			calls = [
				{ name: "write", arguments: { path: "remote-proof.txt", content: "REMOTE_FILE_SENTINEL" } },
				{ name: probe, arguments: {} },
				{
					name: "subagent",
					arguments: { agent: "remote-worker", task: "Read the remote rules file and report" },
				},
			];
		}
		send({
			tool_calls: calls.map((call, index) => ({
				index,
				id: `call-${index}`,
				type: "function",
				function: { name: call.name, arguments: JSON.stringify(call.arguments) },
			})),
		});
		send({}, "tool_calls");
	} else {
		send({ content: child ? "REMOTE_CHILD_COMPLETED" : "Linux runtime continued while detached" });
		send({}, "stop");
	}
	response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
	`${root}/agent/models.json`,
	JSON.stringify({
		providers: {
			"runtime-test": {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
				apiKey: "isolated-test-value",
				models: [
					{
						id: "m0",
						name: "M0",
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
let first, second, bridgeChild;
let bridgeExit;
try {
	const starts = await Promise.allSettled([cli("start"), cli("start")]);
	const ready = starts.filter((item) => item.status === "fulfilled").map((item) => item.value);
	if (!ready.length || new Set(ready.map((item) => item.instanceId)).size !== 1)
		throw new Error("Concurrent starts produced no unique owner");
	if ((await stat(socket)).mode % 512 !== 0o600) throw new Error("Socket is not private");
	const info = ready[0];
	process.kill(info.pid, "SIGSTOP");
	try {
		let locked = false;
		try {
			await exec("flock", ["-n", `${root}/run/owner.lock`, "true"], { timeout: 2000 });
		} catch (error) {
			locked = error.code === 1;
		}
		if (!locked) throw new Error("A stopped daemon lost its lifetime lock");
	} finally {
		process.kill(info.pid, "SIGCONT");
	}

	bridgeChild = spawn(process.execPath, [entry, "bridge", "--root", root], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	bridgeExit = new Promise((resolve) => bridgeChild.once("exit", resolve));
	first = RuntimeClient.fromStream(
		Duplex.from({ readable: bridgeChild.stdout, writable: bridgeChild.stdin }),
	);
	const attached = await first.attach("linux-integration");
	await first.invoke("getLoadedSessions");
	second = await RuntimeClient.connect(socket);
	try {
		await second.attach("second-controller");
		throw new Error("Second controller accepted");
	} catch (error) {
		if (error.code !== "BUSY") throw error;
	}
	second.close();
	const session = await first.invoke("createSession", {
		options: { cwd: "/state/project", provider: "runtime-test", modelId: "m0", thinkingLevel: "off" },
	});
	const session2 = await first.invoke("createSession", {
		options: { cwd: "/state/project-two", provider: "runtime-test", modelId: "m0", thinkingLevel: "off" },
	});
	await first.invoke("setPermissionMode", { sessionId: session.sessionId, mode: "fullAccess" });
	// Send once, deliberately discard the ACK, then disconnect after the model receives it.
	bridgeChild.stdin.write(
		`${JSON.stringify({
			type: "invoke",
			id: "discarded-ack",
			method: "prompt",
			instanceId: attached.info.instanceId,
			epoch: attached.epoch,
			mutationSeq: 4,
			args: { sessionId: session.sessionId, text: "Test disconnect continuation" },
		})}\n`,
	);
	await requestSeen;
	first.close();
	first = undefined;
	await bridgeExit;
	release();
	// Reattach to the same in-memory backend. No request is replayed.
	second = await RuntimeClient.connect(socket);
	const next = await second.attach("linux-reconnect");
	if (next.info.instanceId !== attached.info.instanceId || next.epoch <= attached.epoch)
		throw new Error("Attachment identity/fence incorrect");
	const operation = { instanceId: attached.info.instanceId, epoch: attached.epoch, sequence: 4 };
	const receipt = await second.queryReceipt(operation);
	if (receipt.state !== "succeeded") throw new Error("Lost ACK receipt not retained");
	const deadline = Date.now() + 15000;
	let messages = [];
	while (Date.now() < deadline) {
		messages = await second.invoke("getSessionMessages", { sessionId: session.sessionId });
		if (JSON.stringify(messages).includes("Linux runtime continued while detached")) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (!JSON.stringify(messages).includes("Linux runtime continued while detached"))
		throw new Error("Detached task did not finish");
	if (
		messages.filter(
			(message) =>
				message.role === "user" && JSON.stringify(message).includes("Test disconnect continuation"),
		).length !== 1
	)
		throw new Error("Lost ACK duplicated the user operation");
	if ((await readFile(`${root}/agent/extension-proof`, "utf8")) !== "REMOTE_EXTENSION_SENTINEL")
		throw new Error("Remote extension did not execute");
	if ((await readFile(`${root}/agent/mcp-proof`, "utf8")) !== "REMOTE_MCP_SENTINEL")
		throw new Error("Remote MCP did not execute");
	if ((await readFile("/state/project/remote-proof.txt", "utf8")) !== "REMOTE_FILE_SENTINEL")
		throw new Error("Remote file tool did not execute");
	if (!JSON.stringify(messages).includes("REMOTE_CHILD_COMPLETED"))
		throw new Error("Remote subagent did not complete");
	if (!(await second.invoke("getStats", { sessionId: session2.sessionId })))
		throw new Error("Second project not managed");
	second.close();
	second = undefined;
	const stopped = await cli("stop");
	if (!stopped.stopped) throw new Error("Service did not stop");
	const restarted = await cli("start");
	second = await RuntimeClient.connect(socket);
	await second.attach("linux-after-restart");
	if (
		restarted.instanceId === operation.instanceId ||
		(await second.queryReceipt(operation)).state !== "unknown"
	)
		throw new Error("Restart claimed an old operation receipt");
	second.close();
	second = undefined;
	await cli("stop");
	console.log(
		JSON.stringify({
			passed: true,
			node: process.version,
			arch: process.arch,
			concurrentStarts: 1,
			singleController: true,
			detachedCompletion: true,
			multipleProjects: true,
			instancePreserved: true,
			remoteExtension: true,
			remoteMcp: true,
			remoteSubagent: true,
			remoteRules: true,
			stdioBridge: true,
			kernelLifetimeLock: true,
			lostAckWithoutReplay: true,
			restartOutcomeUnknown: true,
		}),
	);
} finally {
	release();
	first?.close();
	second?.close();
	await new Promise((resolve) => model.close(resolve));
	try {
		await cli("stop");
	} catch {}
}
