// Offline packaged-worker smoke: node scripts/smoke-channels.mjs
// Uses only a fresh ignored fixture; no models, credentials or user agent data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
let databaseHost;
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
	const { ChannelDatabaseService, ChannelService } = await import(
		pathToFileURL(join(outdir, "service.mjs")).href
	);
	databaseHost = new ChannelDatabaseService({ agentDir });
	service = new ChannelService({ projectRoot, agentDir, database: databaseHost });
	const sender = { sessionId: "sender", sessionName: "Sender" };
	const reader = { sessionId: "reader", sessionName: "Reader" };
	await service.manage(sender, { action: "create", topic: "smoke" });
	assert.equal(await readFile(join(projectRoot, ".gitignore"), "utf8"), "existing-rule\n");
	const metadata = join(agentDir, "channels");
	assert.deepEqual(
		(await readdir(metadata)).filter((name) => name.endsWith(".sqlite")),
		["channels.sqlite"],
	);
	assert.deepEqual((await readdir(projectRoot)).sort(), [".git", ".gitignore"]);
	const other = new ChannelService({ projectRoot: join(root, "other"), agentDir, database: databaseHost });
	await other.manage(sender, { action: "create", topic: "smoke" });
	await other.post(sender, "smoke", "another project's message", "post-0");
	assert.equal(
		(await other.read(sender, { topic: "smoke", mode: "start" }, "other-read")).messages[0].body,
		"another project's message",
	);
	await other.close();
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
	await databaseHost.close();
	await rm(projectRoot, { recursive: true });
	databaseHost = new ChannelDatabaseService({ agentDir });
	service = new ChannelService({ projectRoot, agentDir, database: databaseHost });
	assert.deepEqual(await service.snapshot(reader.sessionId), [{ topic: "smoke", unread: 0 }]);
	await service.prepareMaintenance(reader.sessionId, "archive", "archive", join(projectRoot, "reader.jsonl"));
	await service.completeMaintenance(reader.sessionId, "archive", "archived");
	await assert.rejects(service.snapshot(reader.sessionId), /fenced/);
	await service.completeMaintenance(reader.sessionId, "archive", "active");
	assert.deepEqual(await service.snapshot(reader.sessionId), []);
	console.log(
		"PASS: packaged single-database worker, project isolation, no project writes, unread, pagination, restart without project and archive",
	);
} finally {
	await service?.close();
	await databaseHost?.close();
	await rm(root, { recursive: true, force: true });
}
