import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { ChannelBackendHost } from "../src/tools/channels/backend-host";
import * as channelProject from "../src/tools/channels/project";
import type { ChannelService } from "../src/tools/channels/service";

it("fences services synchronously at shutdown and refuses late construction", async () => {
	const backend = new PiBackend();
	const internal = backend as unknown as {
		channelServices: Map<string, ChannelService>;
		channelServiceAtRoot(root: string): ChannelService;
	};
	const close = vi.fn().mockResolvedValue(undefined);
	internal.channelServices.set("existing", { close } as unknown as ChannelService);
	backend.beginShutdown();
	expect(close).toHaveBeenCalledTimes(1);
	expect(() => internal.channelServiceAtRoot("new")).toThrow("BACKEND_STOPPING");
	await backend.shutdown();
	expect(close).toHaveBeenCalledTimes(1);
});

it("hides cached subscriptions for disabled watch, including read-only sessions", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-disabled-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	writeFileSync(join(root, "settings.json"), JSON.stringify({ channelWatchEnabled: false }));
	const backend = new PiBackend();
	const internal = backend as unknown as {
		registry: { get(id: string): unknown };
		channelSubs: {
			noteSessionOpened(id: string): void;
			reportEntries(id: string, entries: { topic: string; unread: number }[]): void;
			snapshot(id: string): { generation: number; revision: number };
		};
	};
	try {
		for (const readOnly of [false, true]) {
			const id = String(readOnly);
			vi.spyOn(internal.registry, "get").mockReturnValue({ readOnly, session: {} });
			internal.channelSubs.noteSessionOpened(id);
			internal.channelSubs.reportEntries(id, [{ topic: "old", unread: 3 }]);
			const before = internal.channelSubs.snapshot(id);
			const hidden = await backend.getChannelSubscriptions(id);
			expect(hidden.topics).toEqual([]);
			expect(hidden.unreadCounts).toEqual({});
			expect(hidden.generation).toBe(before.generation);
			expect(hidden.revision).toBeGreaterThan(before.revision);
			vi.restoreAllMocks();
		}
	} finally {
		await backend.shutdown();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

it("does not rewrite an existing registration", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-register-"));
	const host = new ChannelBackendHost(root, () => {
		throw new Error("unexpected service");
	});
	try {
		await host.bind("session", root, root);
		await host.register(root);
		const path = join(root, "channels", "channels.sqlite");
		const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs };
		await host.register(root);
		expect(readFileSync(path)).toEqual(before.bytes);
		expect(statSync(path).mtimeMs).toBe(before.mtime);
		expect(await host.binding("session")).toEqual({ root, cwd: root });
		await host.register(join(root, "other"));
		expect(await host.binding("session")).toEqual({ root, cwd: root });
	} finally {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("ignores and preserves legacy registration while persisting new bindings across restarts", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-bind-"));
	const first = new ChannelBackendHost(root, () => {
		throw new Error("unexpected service");
	});
	const second = new ChannelBackendHost(root, () => {
		throw new Error("unexpected service");
	});
	try {
		const file = join(root, "channel-projects.json");
		const legacy = JSON.stringify({ projects: [root], bindings: { old: { root, cwd: root } } });
		writeFileSync(file, legacy);
		expect(await first.binding("old")).toBeUndefined();
		await first.bind("session", root, root);
		await first.close();
		expect(await second.binding("session")).toEqual({ root, cwd: root });
		await expect(second.bind("session", join(root, "other"), root)).rejects.toThrow("conflicts");
		expect(readFileSync(file, "utf8")).toBe(legacy);
	} finally {
		await Promise.all([first.close(), second.close()]);
		rmSync(root, { recursive: true, force: true });
	}
});

it("serializes concurrent registrations from independent workers and rejects conflicting bindings", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-workers-"));
	const agent = join(root, "agent");
	const hosts = Array.from(
		{ length: 3 },
		() =>
			new ChannelBackendHost(agent, () => {
				throw new Error("unexpected service");
			}),
	);
	try {
		const roots = [join(root, "one"), join(root, "two")];
		await Promise.all(roots.map((project, index) => hosts[index].bind(`s${index}`, project, project)));
		await Promise.all([hosts[0].close(), hosts[1].close()]);
		const restarted = hosts[2];
		expect(await restarted.binding("s0")).toEqual({ root: roots[0], cwd: roots[0] });
		expect(await restarted.binding("s1")).toEqual({ root: roots[1], cwd: roots[1] });
		await expect(restarted.bind("s0", roots[1], roots[1])).rejects.toThrow("conflicts");
	} finally {
		await Promise.all(hosts.map((host) => host.close()));
		rmSync(root, { recursive: true, force: true });
	}
});

it("scopes deletion fingerprints by project even for the same operation", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-fingerprint-"));
	const host = new ChannelBackendHost(root, () => {
		throw new Error("unexpected service");
	});
	try {
		const first = join(root, "first");
		const second = join(root, "second");
		await host.recordDeleteFingerprint(first, "op", null);
		expect(await host.deleteFingerprint(second, "op")).toBeUndefined();
		await host.recordDeleteFingerprint(second, "op", null);
		expect(await host.deleteFingerprint(first, "op")).toBeNull();
		expect(await host.deleteFingerprint(second, "op")).toBeNull();
		await expect(host.recordDeleteFingerprint(first, "op", null)).rejects.toThrow();
	} finally {
		await host.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("refreshes writable peers in the same project and tolerates snapshot errors", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-peers-"));
	const other = join(root, "other");
	mkdirSync(other);
	const backend = new PiBackend();
	const internal = backend as unknown as {
		registry: { list: () => unknown[]; get: (id: string) => unknown };
		refreshChannelPeers: (id: string, cwd: string, mode: undefined) => Promise<void>;
	};
	const entries = [
		{ session: { sessionId: "sender" }, cwd: root, modeRef: {} },
		{ session: { sessionId: "peer" }, cwd: root, modeRef: {} },
		{ session: { sessionId: "readonly" }, cwd: root, modeRef: {}, readOnly: true },
		{ session: { sessionId: "other" }, cwd: other, modeRef: {} },
	];
	vi.spyOn(internal.registry, "list").mockReturnValue(entries);
	vi.spyOn(internal.registry, "get").mockImplementation((id) =>
		entries.find((entry) => entry.session.sessionId === id),
	);
	const refresh = vi
		.spyOn(backend, "getChannelSubscriptions")
		.mockRejectedValue(new Error("storage unavailable"));
	try {
		await internal.refreshChannelPeers("sender", root, undefined);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(refresh).toHaveBeenCalledWith("peer");
		expect(refresh).toHaveBeenCalledWith("other");
	} finally {
		vi.restoreAllMocks();
		await backend.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

it("persists a binding through the public backend creation entry", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-create-"));
	const agent = join(root, "agent");
	const cwd = join(root, "project", "child");
	mkdirSync(agent);
	mkdirSync(cwd, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	try {
		await expect(backend.createSession({ cwd, channelProjectRoot: agent })).rejects.toThrow(
			"does not contain",
		);
		const session = await backend.createSession({ cwd, channelProjectRoot: join(root, "project") });
		const host = new ChannelBackendHost(agent, () => {
			throw new Error("unexpected service");
		});
		try {
			expect((await host.binding(session.sessionId))?.cwd).toBe(cwd);
		} finally {
			await host.close();
		}
	} finally {
		await backend.shutdown();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps an independent non-worktree child separate unless its parent is explicitly bound", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-cwd-only-"));
	const agent = join(root, "agent");
	const project = join(root, "project");
	const child = join(project, "child");
	mkdirSync(agent);
	mkdirSync(child, { recursive: true });
	// Model the external Git probe's non-worktree result; all data stays inside this repository's ignored fixture.
	const rootResolver = vi
		.spyOn(channelProject, "resolveChannelProject")
		.mockImplementation(async (cwd, bound) => bound ?? cwd);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	try {
		const parentSession = await backend.createSession({ cwd: project });
		const childSession = await backend.createSession({ cwd: child });
		const derived = await backend.createSession({ cwd: child, channelProjectRoot: project });
		const host = new ChannelBackendHost(agent, () => {
			throw new Error("unexpected service");
		});
		try {
			expect((await host.binding(parentSession.sessionId))?.root).toBe(project);
			expect((await host.binding(childSession.sessionId))?.root).toBe(child);
			expect((await host.binding(childSession.sessionId))?.cwd).toBe(child);
			expect((await host.binding(derived.sessionId))?.root).toBe(project);
		} finally {
			await host.close();
		}
	} finally {
		await backend.shutdown();
		rootResolver.mockRestore();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

it("read-only service access neither registers a project nor runs deletion recovery", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-read-only-host-"));
	const agent = join(root, "agent");
	mkdirSync(agent);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const backend = new PiBackend();
	const internal = backend as unknown as {
		channelService(cwd: string, root: string, readOnly: boolean): Promise<ChannelService>;
		recoverChannelDeletes(): Promise<void>;
	};
	const recover = vi.spyOn(internal, "recoverChannelDeletes");
	try {
		const service = await internal.channelService(root, root, true);
		expect(await service.snapshot("reader")).toEqual([]);
		expect(recover).not.toHaveBeenCalled();
		expect(existsSync(join(agent, "channels", "channels.sqlite"))).toBe(false);
	} finally {
		await backend.shutdown();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

it("refuses a different session at a fenced source", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-fence-"));
	const agent = join(root, "agent");
	mkdirSync(agent);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const backend = new PiBackend();
	const internal = backend as unknown as {
		channelService(cwd: string): Promise<ChannelService>;
		deleteSessionUnlocked(id: string, file: string): Promise<string>;
		archives: () => Promise<unknown>;
		getSessionCatalog: () => unknown;
	};
	const file = join(root, "session.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "new", cwd: root })}\n`);
	internal.archives = async () => ({});
	internal.getSessionCatalog = () => ({ verify: async () => [{ status: "missing" }] });
	try {
		const service = await internal.channelService(root);
		await service.prepareMaintenance("old", "op", "delete", file);
		await expect(internal.deleteSessionUnlocked("old", file)).rejects.toThrow("identity changed");
		expect(readFileSync(file, "utf8")).toContain('"new"');
		expect(await service.pendingMaintenance()).toMatchObject([{ state: "delete" }]);
	} finally {
		await backend.shutdown();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
