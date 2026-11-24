import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { SessionArchiveService } from "../src/session/archive";
import { SessionCatalog } from "../src/session/catalog";
import { ChannelService } from "../src/tools/channels/service";
import { makeChannelTools } from "../src/tools/channels/tools";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	try {
		for (const close of cleanup.splice(0).reverse()) await close();
	} finally {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	}
});

async function fixture() {
	const base = fileURLToPath(new URL("../../../.local/tmp/channels-missing-project", import.meta.url));
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(join(base, "case-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const missing = join(root, "missing");
	const normal = join(root, "normal");
	await Promise.all([agentDir, missing, normal].map((dir) => mkdir(dir)));
	// Real isolated Git roots prevent discovery of the enclosing repository on every platform.
	await Promise.all([missing, normal].map((dir) => promisify(execFile)("git", ["init", "--quiet", dir])));
	for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) vi.stubEnv(key, root);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	const backend = () => {
		const instance = new PiBackend({ projectTrust: false, permissionGates: false });
		cleanup.push(() => instance.dispose());
		return instance;
	};
	const service = (projectRoot: string) => {
		const instance = new ChannelService({ projectRoot, agentDir });
		cleanup.push(() => instance.close());
		return instance;
	};
	return { root, agentDir, missing, normal, backend, service };
}

function session(cwd: string) {
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "anthropic",
		provider: "anthropic",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing fixture session file");
	return { id: manager.getSessionId(), file };
}

async function removeProject(backend: PiBackend, cwd: string) {
	const preview = await backend.previewSessionProjectDeletion(cwd);
	expect(preview.sessionCount).toBeGreaterThan(0);
	const result = await backend.deleteSessionProject(cwd, preview.token);
	expect(result.failed).toEqual([]);
	expect(result.deleted.length).toBe(preview.sessionCount);
}

it.each(["archive", "delete"] as const)(
	"keeps an opened unbound Git-subdirectory session in the actual project during %s",
	async (operation) => {
		const f = await fixture();
		const nested = join(f.normal, "nested");
		await mkdir(nested);
		const historical = session(nested);
		const backend = f.backend();
		await backend.openSession(historical.file);
		const channel = f.service(f.normal);
		await channel.manage({ sessionId: historical.id }, { action: "create", topic: "work" });
		if (operation === "archive") {
			const result = await backend.archiveSession({
				sessionId: historical.id,
				sessionFile: historical.file,
				expectedRevision: 0,
			});
			await expect(channel.snapshot(historical.id)).rejects.toThrow(/fenced/i);
			await backend.unarchiveSession({
				sessionId: historical.id,
				sessionFile: historical.file,
				expectedRevision: result.revision,
			});
			await expect(channel.snapshot(historical.id)).resolves.toEqual([]);
		} else {
			await backend.deleteSession(historical.id, historical.file);
			await expect(channel.pendingMaintenance()).resolves.toMatchObject([
				{ sessionId: historical.id, state: "deleted" },
			]);
			await expect(channel.snapshot(historical.id)).rejects.toThrow(/fenced/i);
		}
	},
	30_000,
);

it("preserves channel history and peer cursor while a project's archived history is removed", async () => {
	const f = await fixture();
	const archived = session(f.missing);
	const peer = session(f.missing);
	const normal = session(f.normal);
	const backend = f.backend();
	await backend.openSession(archived.file);
	const channel = f.service(f.missing);
	let actor = archived.id;
	const tools = makeChannelTools({ service: async () => channel, actor: () => ({ sessionId: actor }) });
	async function call(name: string, id: string, params: object) {
		const tool = tools.find((item) => item.name === name);
		if (!tool) throw new Error(`Missing channel tool: ${name}`);
		const result = await tool.execute(id, params, undefined, undefined, {} as never);
		expect(result.isError).not.toBe(true);
		return result;
	}
	await call("channel_manage", "create", { action: "create", topic: "work" });
	actor = peer.id;
	await call("channel_manage", "subscribe", { action: "subscribe", topic: "work" });
	actor = archived.id;
	await call("channel_post", "post", { topic: "work", message: "retained message" });
	actor = peer.id;
	await call("channel_read", "read", { topic: "work" });
	expect(await channel.snapshot(peer.id)).toEqual([{ topic: "work", unread: 0 }]);
	await expect(
		backend.archiveSession({ sessionId: archived.id, sessionFile: archived.file, expectedRevision: 0 }),
	).resolves.toMatchObject({ archived: true });
	await backend.dispose();
	await channel.close();
	await rename(f.missing, `${f.missing}-away`);
	const restarted = f.backend();
	const projects = await restarted.querySessionProjects();
	expect(projects.projects.map((p) => p.cwd)).toEqual(expect.arrayContaining([f.missing, f.normal]));
	await expect(restarted.openSession(normal.file)).resolves.toMatchObject({ sessionId: normal.id });
	await removeProject(restarted, f.normal);
	const unavailable = f.service(f.missing);
	expect(await unavailable.snapshot(peer.id)).toEqual([{ topic: "work", unread: 0 }]);
	await expect(access(f.missing)).rejects.toMatchObject({ code: "ENOENT" });
	await rename(`${f.missing}-away`, f.missing);
	const restored = f.service(f.missing);
	expect(await restored.snapshot(peer.id)).toEqual([{ topic: "work", unread: 0 }]);
	const history = await restored.read(
		{ sessionId: peer.id },
		{ topic: "work", mode: "start" },
		"restored-read",
	);
	expect(JSON.stringify(history)).toContain("retained message");
	await rename(f.missing, `${f.missing}-away`);
	await removeProject(restarted, f.missing);
}, 30_000);

it("does not let a registered missing project block a different project's archive", async () => {
	const f = await fixture();
	const missingSession = session(f.missing);
	const archived = session(f.normal);
	const active = session(f.normal);
	const first = f.backend();
	await first.openSession(missingSession.file);
	const channel = f.service(f.missing);
	await channel.manage({ sessionId: missingSession.id }, { action: "create", topic: "work" });
	await first.openSession(archived.file);
	await first.archiveSession({ sessionId: archived.id, sessionFile: archived.file, expectedRevision: 0 });
	await first.dispose();
	await channel.close();
	await rename(f.missing, `${f.missing}-away`);
	const restarted = f.backend();
	expect((await restarted.querySessionProjects()).projects.map((p) => p.cwd)).toContain(f.normal);
	await expect(restarted.openSession(active.file)).resolves.toMatchObject({ sessionId: active.id });
	await removeProject(restarted, f.normal);
}, 30_000);

it("recovers an unbound archive whose session cwd no longer exists", async () => {
	const f = await fixture();
	const archived = session(f.missing);
	const active = session(f.normal);
	const catalog = new SessionCatalog({
		sessionsDir: join(f.agentDir, "sessions"),
		indexPath: join(f.agentDir, "fixture-catalog.sqlite"),
	});
	cleanup.push(() => catalog.dispose());
	const archive = new SessionArchiveService({
		agentDir: f.agentDir,
		catalog: () => catalog,
		getSession: () => undefined,
		hasPending: () => false,
		disposeSession: async () => {},
		withFile: async (_files, operation) => operation(),
	});
	await archive.init();
	await archive.archive({ sessionId: archived.id, sessionFile: archived.file, expectedRevision: 0 });
	await catalog.dispose();
	await rename(f.missing, `${f.missing}-away`);
	const backend = f.backend();
	await vi.waitFor(
		async () => {
			expect((await backend.querySessionProjects()).projects.map((p) => p.cwd)).toEqual(
				expect.arrayContaining([f.normal, f.missing]),
			);
		},
		{ timeout: 10_000 },
	);
	await expect(backend.openSession(active.file)).resolves.toMatchObject({ sessionId: active.id });
	await removeProject(backend, f.normal);
	await removeProject(backend, f.missing);
}, 30_000);

it("retains a missing archived source without blocking healthy sessions, then retries on restart", async () => {
	const f = await fixture();
	const archived = session(f.missing);
	const active = session(f.normal);
	const before = f.backend();
	const archive = new SessionArchiveService({
		agentDir: f.agentDir,
		catalog: () => before.getSessionCatalog(),
		getSession: () => undefined,
		hasPending: () => false,
		disposeSession: async () => {},
		withFile: async (_files, operation) => operation(),
	});
	await archive.init();
	await archive.archive({ sessionId: archived.id, sessionFile: archived.file, expectedRevision: 0 });
	const authorityPath = join(f.agentDir, "session-archive.json");
	const authority = await readFile(authorityPath);
	const bytes = await readFile(archived.file);
	await before.shutdown();
	await rm(archived.file);
	const after = f.backend();
	await expect(after.querySessionCatalog({ cwd: f.normal, limit: 100 })).resolves.toMatchObject({
		sessions: [expect.objectContaining({ sessionId: active.id })],
	});
	await expect(after.openSession(active.file)).resolves.toMatchObject({ sessionId: active.id });
	expect(await readFile(authorityPath)).toEqual(authority);
	await expect(after.openSession(archived.file)).rejects.toThrow();
	await after.shutdown();
	await writeFile(archived.file, bytes);
	const restarted = f.backend();
	await expect(restarted.querySessionCatalog({ cwd: f.normal, limit: 100 })).resolves.toBeDefined();
	expect(await readFile(authorityPath)).toEqual(authority);
	await expect(f.service(f.missing).pendingMaintenance()).resolves.toMatchObject([
		{ sessionId: archived.id, state: "archived" },
	]);
	await expect(restarted.openSession(archived.file)).rejects.toThrow(/archived|unresolved/i);
}, 30_000);

it("does not treat a conflicting maintenance source as a locally missing record", async () => {
	const f = await fixture();
	const archived = session(f.missing);
	session(f.normal);
	const before = f.backend();
	const archive = new SessionArchiveService({
		agentDir: f.agentDir,
		catalog: () => before.getSessionCatalog(),
		getSession: () => undefined,
		hasPending: () => false,
		disposeSession: async () => {},
		withFile: async (_files, operation) => operation(),
	});
	await archive.init();
	await archive.archive({ sessionId: archived.id, sessionFile: archived.file, expectedRevision: 0 });
	await before.shutdown();
	const authorityPath = join(f.agentDir, "session-archive.json");
	const authority = await readFile(authorityPath);
	const channels = f.service(f.missing);
	await channels.prepareMaintenance(archived.id, "conflict", "archive", `${archived.file}.different`);
	await channels.close();
	await rm(archived.file);
	await expect(f.backend().querySessionCatalog({ cwd: f.normal, limit: 100 })).rejects.toThrow(
		/source changed/i,
	);
	expect(await readFile(authorityPath)).toEqual(authority);
}, 30_000);

it("logs archive initialization failure before creating the catalog", async () => {
	const f = await fixture();
	const first = f.backend();
	await first.querySessionProjects();
	await first.dispose();
	await rm(join(f.agentDir, "session-archive-initialized.json"));
	const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const backend = f.backend();
	const catalog = vi.spyOn(backend, "getSessionCatalog");
	await expect(backend.querySessionProjects()).rejects.toThrow(/marker missing/i);
	expect(catalog).not.toHaveBeenCalled();
	const logs = output.mock.calls.map((args) => String(args[0])).join("");
	expect(logs).toContain("Archive authority initialization failed before catalog query");
	expect(logs).toMatch(/marker missing/i);
}, 30_000);
