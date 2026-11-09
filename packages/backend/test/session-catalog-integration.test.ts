import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { JsonStore } from "../src/json-store";
import { PiBackend } from "../src/pi-backend";
import { SessionCatalog } from "../src/session/catalog";

const base = resolve("../../.local/tmp/session-archive-catalog/integration");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});
async function fixture() {
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(join(base, "backend-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	cleanups.push(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});
	const cwd = join(root, "project");
	await mkdir(cwd);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	cleanups.push(() => backend.dispose());
	return { backend, cwd, root, agentDir: join(root, "agent") };
}
it("renames a real unpersisted SDK session through the backend without creating history", async () => {
	const { backend, cwd } = await fixture();
	const meta = await backend.createSession({ cwd });
	await backend.setSessionName(meta.sessionId, "Blank draft");
	expect(backend.getLoadedSessions().find((row) => row.meta.sessionId === meta.sessionId)?.meta.name).toBe(
		"Blank draft",
	);
	await expect(readFile(meta.sessionFile!)).rejects.toMatchObject({ code: "ENOENT" });
	const preview = await backend.previewSessionProjectDeletion(cwd);
	expect(preview.sessionCount).toBe(1);
});
it("refuses deleting a pending archive before touching history or its owner", async () => {
	const { backend, cwd, agentDir } = await fixture();
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "Preserve pending history", timestamp: Date.now() });
	const file = manager.getSessionFile()!;
	const meta = await backend.openSession(file);
	const bytes = await readFile(file, "utf8");
	await writeFile(
		join(agentDir, "session-archive.json"),
		JSON.stringify({
			version: 1,
			records: [
				{
					id: meta.sessionId,
					file,
					revision: 1,
					archivedAt: Date.now(),
					opId: "pending-operation",
					phase: "prepared",
				},
			],
		}),
	);
	await expect(backend.deleteSession(meta.sessionId, file)).rejects.toThrow(/unresolved/);
	expect(await readFile(file, "utf8")).toBe(bytes);
	expect(backend.getLoadedSessions().some((row) => row.meta.sessionId === meta.sessionId)).toBe(true);
});

it("keeps authority usable but refuses stale catalog queries when initial bulk mirroring fails", async () => {
	const { backend, cwd, root, agentDir } = await fixture();
	const worker = join(root, "failed-index.mjs");
	const requests = join(root, "requests.log");
	await writeFile(
		worker,
		`import { parentPort, workerData } from "node:worker_threads";
import { appendFileSync } from "node:fs";
parentPort.on("message", ({id, method}) => {
 appendFileSync(workerData.indexPath, method + "\\n");
 parentPort.postMessage(method === "archiveSnapshot" ? {id, error:"index projection unavailable"} : {id, result:undefined});
});`,
	);
	const catalog = new SessionCatalog({
		sessionsDir: join(agentDir, "sessions"),
		indexPath: requests,
		workerPath: worker,
	});
	vi.spyOn(backend, "getSessionCatalog").mockReturnValue(catalog);
	cleanups.push(async () => {
		await backend.dispose();
		await catalog.dispose();
	});
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "Readable authority", timestamp: Date.now() });
	await expect(backend.openSession(manager.getSessionFile()!)).resolves.toMatchObject({
		sessionId: manager.getSessionId(),
	});
	await expect(backend.querySessionProjects()).rejects.toThrow(/index projection unavailable/);
	expect((await readFile(requests, "utf8")).split("\n")).not.toContain("projects");
});

it("refuses deleting a loaded session whose source header identity changed", async () => {
	const { backend, cwd } = await fixture();
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "Keep the replacement body", timestamp: Date.now() });
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing session file");
	const meta = await backend.openSession(file);
	const original = await readFile(file, "utf8");
	const newline = original.indexOf("\n");
	const header = JSON.parse(original.slice(0, newline));
	header.id = "externally-replaced-session-id";
	const replacement = Buffer.from(`${JSON.stringify(header)}${original.slice(newline)}`);
	await writeFile(file, replacement);
	const dispose = vi.spyOn(AgentSession.prototype, "dispose");
	await expect(backend.deleteSession(meta.sessionId, file)).rejects.toThrow(/identity changed/);
	expect(dispose).not.toHaveBeenCalled();
	expect(backend.getLoadedSessions().some((row) => row.meta.sessionId === meta.sessionId)).toBe(true);
	expect(await readFile(file)).toEqual(replacement);
});

it("prevents GC from closing a loaded session while its prepared archive write returns", async () => {
	const { backend, cwd, agentDir } = await fixture();
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "Archive this conversation", timestamp: Date.now() });
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing session file");
	const meta = await backend.openSession(file);
	let release!: () => void;
	let reached!: () => void;
	const barrier = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	const write = JsonStore.prototype.write;
	const spy = vi.spyOn(JsonStore.prototype, "write").mockImplementation(async function (value) {
		await write.call(this, value);
		const data = value as { records?: Array<{ id: string; phase: string }> } | null;
		if (data?.records?.some((record) => record.id === meta.sessionId && record.phase === "prepared")) {
			reached();
			await hold;
		}
	});
	const archiving = backend.archiveSession({
		sessionId: meta.sessionId,
		sessionFile: file,
		expectedRevision: 0,
	});
	try {
		await Promise.race([
			barrier,
			archiving.then(() => {
				throw new Error("Archive completed before prepared barrier");
			}),
		]);
		expect(
			JSON.parse(await readFile(join(agentDir, "session-archive.json"), "utf8")).records[0],
		).toMatchObject({
			id: meta.sessionId,
			phase: "prepared",
		});
		await expect(backend.closeSession(meta.sessionId, "gc")).resolves.toEqual({ closed: false });
		expect(backend.getLoadedSessions().some((row) => row.meta.sessionId === meta.sessionId)).toBe(true);
		release();
		await expect(archiving).resolves.toMatchObject({ archived: true });
		expect(
			JSON.parse(await readFile(join(agentDir, "session-archive.json"), "utf8")).records[0],
		).toMatchObject({
			id: meta.sessionId,
			phase: "archived",
		});
	} finally {
		release();
		await Promise.allSettled([archiving]);
		spy.mockRestore();
	}
});

it("refuses deleting a loaded identity with a second source before disposing its owner", async () => {
	const { backend, cwd } = await fixture();
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "Keep this conversation", timestamp: Date.now() });
	const file = manager.getSessionFile()!;
	const meta = await backend.openSession(file);
	const duplicate = join(dirname(file), "duplicate.jsonl");
	await copyFile(file, duplicate);
	const bytes = await readFile(file, "utf8");
	await expect(backend.deleteSession(meta.sessionId, file)).rejects.toThrow(/ambiguous/);
	expect(backend.getLoadedSessions().some((row) => row.meta.sessionId === meta.sessionId)).toBe(true);
	expect(await readFile(file, "utf8")).toBe(bytes);
	expect(await readFile(duplicate, "utf8")).toBe(bytes);
});
