import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createExecutionHandlers } from "../src/execution-handlers";
import { PackageAdmin } from "../src/packages/admin";
import { PiBackend } from "../src/pi-backend";
import type { RegisteredSession, SessionRegistry } from "../src/session/registry";

let root: string;
let agent: string;
let backend: PiBackend | undefined;
beforeEach(async () => {
	const base = resolve(".local/tmp/package-context-tests");
	await mkdir(base, { recursive: true });
	root = await mkdtemp(join(base, "case-"));
	agent = join(root, "agent");
	await mkdir(agent);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [] }));
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
});
afterEach(async () => {
	await backend?.shutdown();
	backend = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

async function installFixture(base: string, version: string) {
	const path = join(base, "npm/node_modules/demo");
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "package.json"), JSON.stringify({ name: "demo", version }));
	await writeFile(join(base, "settings.json"), JSON.stringify({ packages: ["npm:demo"] }));
}

it("uses fresh SDK settings after external install and removal without restarting", async () => {
	const admin = new PackageAdmin({ reloadIdleSessions: async () => {} });
	expect(await admin.listConfiguredPackages()).toEqual([]);
	await installFixture(agent, "1.0.0");
	expect(await admin.listConfiguredPackages()).toEqual([
		{ source: "npm:demo", scope: "user", installedVersion: "1.0.0" },
	]);
	await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: [] }));
	expect(await admin.listConfiguredPackages()).toEqual([]);
});

async function setupSessions() {
	const startup = join(root, "startup");
	await mkdir(startup);
	backend = new PiBackend({ defaultCwd: startup });
	const entries = new Map<string, RegisteredSession>();
	for (const [id, version, trusted] of [
		["a", "1.0.0", true],
		["b", "2.0.0", true],
		["denied", "9.0.0", false],
	] as const) {
		const cwd = join(root, id);
		await installFixture(join(cwd, ".pi"), version);
		entries.set(id, {
			cwd,
			session: {
				sessionId: id,
				settingsManager: SettingsManager.create(cwd, agent, { projectTrusted: trusted }),
			},
		} as RegisteredSession);
	}
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	vi.spyOn(registry, "get").mockImplementation((id) => entries.get(id));
	return { handlers: createExecutionHandlers(backend), entries, backend };
}

it("rejects corrupted settings instead of publishing an empty installation list", async () => {
	await installFixture(agent, "1.0.0");
	const admin = new PackageAdmin({ reloadIdleSessions: async () => {} });
	expect(await admin.listConfiguredPackages()).toHaveLength(1);
	await writeFile(join(agent, "settings.json"), "{");
	await expect(admin.listConfiguredPackages()).rejects.toThrow();
});

it("routes project reads and removals through the requested session, not the startup directory", async () => {
	const { handlers, entries, backend } = await setupSessions();
	expect(await handlers.listConfiguredPackages({ sessionId: "a" })).toEqual([
		{ source: "npm:demo", scope: "project", installedVersion: "1.0.0" },
	]);
	expect(await handlers.listConfiguredPackages({ sessionId: "b" })).toEqual([
		{ source: "npm:demo", scope: "project", installedVersion: "2.0.0" },
	]);
	const remove = vi.spyOn(backend.packages, "removePackage").mockResolvedValue(undefined);
	await handlers.removePackage({ source: "npm:demo", scope: "project", sessionId: "b" });
	expect(remove).toHaveBeenCalledWith("npm:demo", "project", {
		cwd: entries.get("b")?.cwd,
		projectTrusted: true,
	});
	await handlers.removePackage({ source: "npm:demo", scope: "user", sessionId: "gone" });
	expect(remove).toHaveBeenLastCalledWith("npm:demo", "user", undefined);
	expect(() => handlers.listConfiguredPackages({ sessionId: "gone" })).toThrow("Session not found");
});

it("does not read untrusted project settings or fall back to the startup project", async () => {
	const { handlers, backend } = await setupSessions();
	expect(await handlers.listConfiguredPackages({ sessionId: "denied" })).toEqual([]);
	expect(await handlers.listConfiguredPackages({})).toEqual([]);
	await expect(backend.removePackage("npm:demo", "project")).rejects.toThrow("requires a session");
	await expect(
		handlers.removePackage({ source: "npm:demo", scope: "project", sessionId: "denied" }),
	).rejects.toThrow();
});
