/** Packaged worker/transaction smoke. Synthetic files only; never contacts a model. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { build } from "esbuild";
import { expectNativeExit } from "./release/native-exit.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let executable = process.argv[3];
if (process.argv[2] === "--build-output") {
	const directory = resolve(executable, "win-unpacked");
	const names = (await readdir(directory)).filter(
		(name) => name.endsWith(".exe") && !/^(elevate|uninstall)/i.test(name),
	);
	assert.equal(names.length, 1, "Expected one Windows application executable");
	executable = join(directory, names[0]);
} else assert.equal(process.argv[2], "--app");
assert(executable && isAbsolute(executable) && (await stat(executable)).isFile());
const evidence = join(repo, ".local/tmp/session-media-package-check");
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(evidence, "native-")),
	agent = join(root, "agent"),
	sessions = join(agent, "sessions");
await mkdir(sessions, { recursive: true, mode: 0o700 });
const helper = join(root, "private-directory.mjs");
await build({
	entryPoints: [join(repo, "packages/backend/src/storage/private-directory.ts")],
	outfile: helper,
	bundle: true,
	platform: "node",
	format: "esm",
});
const { privateDirectory } = await import(pathToFileURL(helper).href);
await privateDirectory(agent, true);
await privateDirectory(sessions, true);
await writeFile(
	join(agent, ".percho-local-storage.json"),
	JSON.stringify({
		version: 1,
		id: randomUUID(),
		kind: "adopt",
		target: agent,
		sources: [],
		createdAt: new Date().toISOString(),
		files: 0,
		bytes: 0,
	}),
	{ mode: 0o600 },
);
const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSl8AAAAASUVORK5CYII=",
		"base64",
	),
	large = Buffer.concat([png, Buffer.alloc(256 * 1024, 7)]);
const image = { mimeType: "image/png", data: large.toString("base64") },
	inputImage = { mimeType: "image/png", data: png.toString("base64") },
	file = join(sessions, "synthetic.jsonl");
const rows = [
	{
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: randomUUID(),
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: root,
	},
	{
		type: "message",
		id: "user",
		parentId: null,
		message: {
			role: "user",
			content: [
				{ type: "text", text: "Synthetic only" },
				{ type: "image", ...inputImage },
			],
			timestamp: 1,
		},
	},
	{
		type: "message",
		id: "assistant",
		parentId: "user",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call", name: "show_image", arguments: {} }],
			api: "openai-completions",
			provider: "synthetic",
			model: "synthetic",
			timestamp: 2,
		},
	},
	{
		type: "message",
		id: "display",
		parentId: "assistant",
		message: {
			role: "toolResult",
			toolCallId: "call",
			toolName: "show_image",
			content: [{ type: "text", text: "Synthetic images" }],
			details: { images: [image, image, image], unknown: "preserved" },
			timestamp: 3,
		},
	},
	{
		type: "message",
		id: "read",
		parentId: "display",
		message: {
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "image", ...inputImage }],
			details: { images: [inputImage] },
			timestamp: 4,
		},
	},
];
rows.push({
	type: "message",
	id: "alternate-display",
	parentId: "assistant",
	message: {
		role: "toolResult",
		toolCallId: "call",
		toolName: "show_image",
		content: [{ type: "text", text: "Alternate synthetic branch" }],
		details: { images: [image] },
		timestamp: 5,
	},
});
const original = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n{broken-line\n\n`);
await writeFile(file, original, { mode: 0o600 });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
	pause = () => new Promise((resolve) => setTimeout(resolve, 50));
async function wait(check, label, timeout = 60000) {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		if (await check()) return;
		await pause();
	}
	throw new Error(`Timed out: ${label}`);
}
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const env = { ...process.env, PERCHO_AGENT_DIR: agent };
for (const key of [
	"PI_CODING_AGENT_DIR",
	"ELECTRON_RUN_AS_NODE",
	"ELECTRON_RENDERER_URL",
	"PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT",
])
	delete env[key];
const child = spawn(
	executable,
	[
		`--user-data-dir=${join(root, "profile")}`,
		`--remote-debugging-port=${port}`,
		...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
	],
	{ cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "",
	socket,
	lock,
	sequence = 0;
const pending = new Map();
child.stdout.on("data", (chunk) => {
	log += chunk;
});
child.stderr.on("data", (chunk) => {
	log += chunk;
});
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = ++sequence,
			timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`CDP timeout: ${method}`));
			}, 30000);
		pending.set(id, { resolve, reject, timer });
		socket.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails)
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	return result.result?.value;
};
const invoke = (method, args) =>
	evaluate(`window.pi.forEnvironment({kind:'local'})[${JSON.stringify(method)}](${JSON.stringify(args)})`);
async function poll(job, allowFailure = false) {
	await wait(async () => {
		job = await invoke("getSessionMediaJob", { jobId: job.jobId });
		return !["queued", "running", "cancelling"].includes(job.status);
	}, "maintenance job");
	if (!allowFailure) assert.equal(job.status, "completed", job.error);
	return job;
}
try {
	let page;
	await wait(async () => {
		assert.equal(child.exitCode, null);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
			page = (await response.json()).find((page) => page.type === "page" && page.url.startsWith("file:"));
			return !!page;
		} catch {
			return false;
		}
	}, "packaged renderer");
	socket = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data),
			call = pending.get(message.id);
		if (!call) return;
		pending.delete(message.id);
		clearTimeout(call.timer);
		if (message.error) call.reject(new Error(JSON.stringify(message.error)));
		else call.resolve(message.result);
	});
	await wait(
		() =>
			evaluate("document.documentElement?.dataset.appReady==='true' && !document.getElementById('splash')"),
		"app ready",
	);
	const preview = await poll(await invoke("startSessionMediaPreview", { sessionFile: file }));
	assert.equal(preview.result.imageCount, 4);
	assert(preview.result.projectedFileBytes < original.length * 0.15);
	assert.equal(hash(await readFile(file)), hash(original));
	const outside = join(root, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "source.jsonl"), original);
	await symlink(outside, join(sessions, "escape"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(
		invoke("startSessionMediaPreview", { sessionFile: join(sessions, "escape/source.jsonl") }),
	);
	let lockedFailure = false;
	if (process.platform === "win32") {
		const code =
			"$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()));$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::WriteLine('LOCK_READY');[Console]::Out.Flush();[void][Console]::ReadLine()}finally{$f.Dispose()}";
		lock = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		let ready = "",
			lockError = "";
		lock.stdout.on("data", (chunk) => {
			ready += chunk;
		});
		lock.stderr.on("data", (chunk) => {
			lockError += chunk;
		});
		lock.stdin.write(Buffer.from(file).toString("base64") + "\n");
		await wait(() => {
			if (lock.exitCode !== null) throw new Error(`File lock helper failed: ${lockError}`);
			return ready.includes("LOCK_READY");
		}, "Windows exclusive-delete lock");
		const lockedRequestId = randomUUID();
		const failed = await poll(
			await invoke("startSessionMediaCompaction", {
				sessionFile: file,
				requestId: lockedRequestId,
				expectedHash: preview.result.sourceHash,
				confirmed: true,
			}),
			true,
		);
		assert.equal(failed.status, "failed");
		assert.match(failed.error, /EPERM|EACCES|EBUSY/);
		const interrupted = await invoke("getSessionMediaTransaction", { requestId: lockedRequestId });
		assert.equal(interrupted.phase, "publishing");
		assert.equal(hash(await readFile(interrupted.backup)), hash(original));
		assert.equal(hash(await readFile(file)), hash(original));
		lockedFailure = true;
		lock.stdin.end("release\n");
		await wait(() => lock.exitCode !== null, "release Windows file lock");
		// A failed replace retains its durable recovery record; a fresh request
		// must not bypass that guard. Recover the same transaction after unlock.
		const resumed = await poll(
			await invoke("resumeSessionMediaJob", { requestId: lockedRequestId, confirmed: true }),
		);
		assert.equal(resumed.transaction.phase, "complete");
		const reset = await poll(
			await invoke("startSessionMediaRestore", {
				requestId: randomUUID(),
				compactionRequestId: lockedRequestId,
				confirmed: true,
			}),
		);
		assert.equal(reset.transaction.phase, "complete");
		assert.equal(hash(await readFile(file)), hash(original));
	}
	const requestId = randomUUID(),
		input = { sessionFile: file, requestId, expectedHash: preview.result.sourceHash, confirmed: true },
		started = await invoke("startSessionMediaCompaction", input),
		done = await poll(started);
	assert.equal(done.transaction.phase, "complete");
	assert.equal((await invoke("startSessionMediaCompaction", input)).jobId, started.jobId);
	const compacted = await readFile(file);
	assert(compacted.length < original.length * 0.15);
	assert(compacted.includes(Buffer.from("{broken-line\n\n")));
	const backup = await readFile(done.transaction.backup);
	assert.equal(hash(backup), hash(original));
	const restored = await poll(
		await invoke("startSessionMediaRestore", {
			requestId: randomUUID(),
			compactionRequestId: requestId,
			confirmed: true,
		}),
	);
	assert.equal(restored.transaction.phase, "complete");
	assert.equal(hash(await readFile(file)), hash(original));
	await privateDirectory(agent, false);
	await privateDirectory(sessions, false);
	const report = {
		platform: process.platform,
		packagedWorker: true,
		images: 4,
		allBranchesAndMalformedLines: true,
		sourceBytes: original.length,
		compactedBytes: compacted.length,
		privateAclVerified: true,
		linkEscapeRejected: true,
		windowsLockedFileFailure: process.platform === "win32" ? lockedFailure : "not-Windows",
		retryAfterUnlock: process.platform === "win32" ? true : "not-Windows",
		resumedInterruptedTransaction: process.platform === "win32" ? true : "not-Windows",
		idempotentReceipt: true,
		backupAndRestoreExact: true,
		paidModelRequests: 0,
	};
	await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
	await expectNativeExit(child, () => evaluate("void window.pi.confirmQuit();true"));
} finally {
	if (lock && lock.exitCode === null) lock.kill();
	if (child.exitCode === null) child.kill();
	for (const call of pending.values()) {
		clearTimeout(call.timer);
		call.reject(new Error("Probe closed"));
	}
	socket?.close();
	await writeFile(join(root, "native.log"), log);
}
