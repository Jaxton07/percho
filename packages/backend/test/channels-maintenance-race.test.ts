import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { SessionArchiveService } from "../src/session/archive";
import { ChannelService } from "../src/tools/channels/service";

const fault = vi.hoisted(() => ({ path: "", mode: "" as "" | "remove" | "denied", hits: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: async (...args: Parameters<typeof fs.open>) => {
			if (args[0] === fault.path && fault.mode) {
				const mode = fault.mode;
				fault.mode = "";
				fault.hits++;
				if (mode === "remove") await fs.rm(fault.path);
				else throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return fs.open(...args);
		},
	};
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	try {
		for (const close of cleanup.splice(0).reverse()) await close();
	} finally {
		fault.path = "";
		fault.mode = "";
		fault.hits = 0;
		vi.unstubAllEnvs();
	}
});

async function fixture() {
	const base = fileURLToPath(new URL("../../../.local/tmp/channels-maintenance-race", import.meta.url));
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(join(base, "case-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	const normal = join(root, "normal");
	await Promise.all([agentDir, project, normal].map((dir) => mkdir(dir)));
	await Promise.all([project, normal].map((dir) => promisify(execFile)("git", ["init", "--quiet", dir])));
	for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) vi.stubEnv(key, root);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	const backend = () => {
		const instance = new PiBackend({ projectTrust: false, permissionGates: false });
		cleanup.push(() => instance.dispose());
		return instance;
	};
	const service = new ChannelService({ projectRoot: project, agentDir });
	cleanup.push(() => service.close());
	return { agentDir, project, normal, backend, service };
}

function session(cwd: string) {
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ role: "user", content: "fixture", timestamp: Date.now() });
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing session file");
	return { id: manager.getSessionId(), file };
}

async function setup() {
	const f = await fixture();
	const archived = session(f.project);
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
	const data = JSON.parse(authority.toString()) as { records: Array<{ opId: string }> };
	await before.shutdown();
	return { ...f, archived, active, authorityPath, authority, opId: data.records[0].opId };
}

it("postpones only the archive whose source disappears between existence check and header open", async () => {
	const f = await setup();
	fault.path = f.archived.file;
	fault.mode = "remove";
	const backend = f.backend();
	await expect(backend.querySessionCatalog({ cwd: f.normal, limit: 100 })).resolves.toMatchObject({
		sessions: [expect.objectContaining({ sessionId: f.active.id })],
	});
	expect(fault.hits).toBe(1);
	expect(await readFile(f.authorityPath)).toEqual(f.authority);
	await expect(f.service.pendingMaintenance()).resolves.toEqual([]);
}, 30_000);

it("completes recovery using an existing matching maintenance fence after the source disappears", async () => {
	const f = await setup();
	await f.service.prepareMaintenance(f.archived.id, f.opId, "archive", f.archived.file);
	fault.path = f.archived.file;
	fault.mode = "remove";
	await expect(f.backend().querySessionCatalog({ cwd: f.normal, limit: 100 })).resolves.toBeDefined();
	expect(fault.hits).toBe(1);
	await expect(f.service.pendingMaintenance()).resolves.toMatchObject([
		{ sessionId: f.archived.id, state: "archived" },
	]);
	expect(await readFile(f.authorityPath)).toEqual(f.authority);
}, 30_000);

it("propagates permission errors at header open", async () => {
	const f = await setup();
	fault.path = f.archived.file;
	fault.mode = "denied";
	await expect(f.backend().querySessionCatalog({ cwd: f.normal, limit: 100 })).rejects.toMatchObject({
		code: "EACCES",
	});
	expect(fault.hits).toBe(1);
	expect(await readFile(f.authorityPath)).toEqual(f.authority);
}, 30_000);

it("rejects a fence for a different source instead of guessing", async () => {
	const f = await setup();
	await f.service.prepareMaintenance(f.archived.id, f.opId, "archive", `${f.archived.file}.different`);
	fault.path = f.archived.file;
	fault.mode = "remove";
	await expect(f.backend().querySessionCatalog({ cwd: f.normal, limit: 100 })).rejects.toThrow(
		/source changed/i,
	);
	expect(await readFile(f.authorityPath)).toEqual(f.authority);
}, 30_000);
