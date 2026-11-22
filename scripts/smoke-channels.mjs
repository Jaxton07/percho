// Offline packaged-worker smoke: node scripts/smoke-channels.mjs
// Uses only a fresh ignored fixture; no models, credentials or user agent data.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const parent = resolve(".local/tmp/pull-based-channels-smoke");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, "run-"));
const projectRoot = join(root, "project");
const agentDir = join(root, "agent");
const outdir = join(root, "bundle");
await Promise.all([mkdir(projectRoot), mkdir(agentDir)]);
execFileSync("git", ["init", "--quiet"], { cwd: projectRoot });
await writeFile(join(projectRoot, ".gitignore"), "existing-rule\n");
let service;
try {
	await build({
		entryPoints: {
			service: "packages/backend/src/tools/channels/service.ts",
			"channels-worker": "packages/backend/src/tools/channels/worker.ts",
		},
		outdir,
		outExtension: { ".js": ".mjs" },
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		logLevel: "silent",
	});
	const { ChannelService } = await import(pathToFileURL(join(outdir, "service.mjs")).href);
	service = new ChannelService({ projectRoot, agentDir });
	const sender = { sessionId: "sender", sessionName: "Sender" };
	const reader = { sessionId: "reader", sessionName: "Reader" };
	await service.manage(sender, { action: "create", topic: "smoke" });
	assert.equal(await readFile(join(projectRoot, ".gitignore"), "utf8"), "existing-rule\n");
	const metadata = join(projectRoot, ".percho", "channels");
	const database = (await readdir(metadata)).find((name) => name.endsWith(".sqlite"));
	assert.ok(database);
	execFileSync("git", ["check-ignore", "--", `.percho/channels/${database}`], { cwd: projectRoot });
	await writeFile(join(metadata, "note.md"), "not private channel storage");
	assert.equal(
		spawnSync("git", ["check-ignore", "--", ".percho/channels/note.md"], { cwd: projectRoot }).status,
		1,
	);
	await service.manage(reader, { action: "subscribe", topic: "smoke" });
	for (let i = 0; i < 60; i++) await service.post(sender, "smoke", `message ${i}`, `post-${i}`);
	assert.deepEqual(await service.snapshot(reader.sessionId), [{ topic: "smoke", unread: 60 }]);
	const history = await service.read(reader, { topic: "smoke", mode: "recent", limit: 1 }, "history");
	assert.equal(history.messages[0].body, "message 59");
	const first = await service.read(reader, { topic: "smoke" }, "unread-first");
	assert.equal(first.messages.length, 50);
	assert.equal(first.unread, 10);
	assert.deepEqual(await service.read(reader, { topic: "smoke" }, "unread-first"), first);
	await service.post(sender, "smoke", "arrived during pagination", "late");
	const last = await service.read(reader, { topic: "smoke", cursor: first.nextCursor }, "unread-last");
	assert.equal(last.messages.length, 10);
	assert.equal(last.hasMore, false);
	assert.equal(last.unread, 1);
	assert.equal(
		(await service.read(reader, { topic: "smoke" }, "unread-new")).messages[0].body,
		"arrived during pagination",
	);
	await service.close();
	service = new ChannelService({ projectRoot, agentDir });
	assert.deepEqual(await service.snapshot(reader.sessionId), [{ topic: "smoke", unread: 0 }]);
	await service.prepareMaintenance(reader.sessionId, "archive", "archive", join(projectRoot, "reader.jsonl"));
	await service.completeMaintenance(reader.sessionId, "archive", "archived");
	await assert.rejects(service.snapshot(reader.sessionId), /fenced/);
	await service.completeMaintenance(reader.sessionId, "archive", "active");
	assert.deepEqual(await service.snapshot(reader.sessionId), []);
	console.log(
		"PASS: packaged worker, short messages, independent unread, snapshot pagination, retry, restart and archive",
	);
} finally {
	await service?.close();
	await rm(root, { recursive: true, force: true });
}
