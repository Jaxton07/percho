import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RemoteRecordCommand, SshPreflight } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	directory: "",
	probe: vi.fn(),
	connect: vi.fn(),
	close: vi.fn(),
	stop: vi.fn(),
	send: vi.fn(),
	detach: vi.fn(),
	observe: vi.fn(),
	detachNotices: vi.fn(),
	attach: vi.fn(),
}));
vi.mock("electron", () => ({
	app: { getPath: () => fixture.directory, getAppPath: () => fixture.directory, isPackaged: false },
}));
vi.mock("./task-notifications", () => ({
	observeTaskNotification: fixture.observe,
	taskNotificationObserver: { detach: fixture.detachNotices, delete: vi.fn(), unload: vi.fn() },
}));
vi.mock("./ipc/send", () => ({ sendToRenderer: fixture.send }));
vi.mock("./environment-router", () => ({ environmentRouter: { attach: fixture.attach } }));
vi.mock("@percho/backend", async () => {
	const storage = await import("../../../backend/src/json-store");
	const ssh = await import("../../../backend/src/runtime/ssh-preflight");
	const args = await import("../../../backend/src/runtime/ssh-arguments");
	return {
		...storage,
		...ssh,
		preflightSsh: fixture.probe,
		validateSshAlias: args.validateSshAlias,
		RemoteMutationUnknownError: class extends Error {},
		SshRuntimeConnection: { connect: fixture.connect },
		remoteAuthGuide: (alias: string, node: string) => ({
			sshCommand: `ssh ${alias}`,
			authCommand: `${node} auth`,
		}),
		installSshRuntime: vi.fn(),
	};
});

import { JsonStore } from "../../../backend/src/json-store";
import { RemoteConnectionManager } from "./remote-connection";

const probe: SshPreflight = {
	alias: "dev",
	target: { hostname: "server", user: "developer", port: "22" },
	uid: 1000,
	home: "/home/developer",
	node: "/usr/bin/node",
	nodeVersion: "22.19.0",
	platform: "linux",
	arch: "arm64",
	glibc: "2.35",
	commands: { sh: true, tar: true, sha256sum: true, flock: true, setsid: true },
	installed: true,
	agentDir: "/home/developer/.percho/agent",
	environmentId: "data",
	serviceState: "stopped",
};
const manifest = {
	releaseId: "v1.0.0",
	protocol: 3,
	artifacts: { arm64: { bytes: 42, sha256: "a".repeat(64) } },
};
let manager: RemoteConnectionManager;
async function command(id?: string): Promise<RemoteRecordCommand> {
	const status = await manager.getStatus();
	const connectionId = id ?? status.connectionId;
	if (!connectionId || !status.epoch || status.generation === undefined)
		throw new Error("Missing test target");
	return { epoch: status.epoch, generation: status.generation, connectionId };
}
async function add(alias = "dev"): Promise<string> {
	const catalog = await manager.getCatalog(),
		status = await manager.getStatus();
	return (
		await manager.add({
			epoch: catalog.epoch,
			generation: status.generation ?? 0,
			catalogRevision: catalog.revision,
			alias,
		})
	).connectionId;
}
async function connect(alias = "dev") {
	const catalog = await manager.getCatalog();
	const id = catalog.records.find((r) => r.alias === alias)?.connectionId ?? (await add(alias));
	return manager.connect(await command(id));
}
async function disconnect() {
	await manager.disconnect(await command());
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(async () => {
	vi.clearAllMocks();
	const root = resolve("../../.local/tmp/ssh-ux-implementation/manager-tests");
	await mkdir(root, { recursive: true });
	fixture.directory = await mkdtemp(`${root}/case-`);
	fixture.probe.mockImplementation(async (alias: string) => ({ ...probe, alias }));
	fixture.stop.mockResolvedValue(undefined);
	fixture.attach.mockReturnValue(fixture.detach);
	fixture.connect.mockImplementation(async (_alias, options) => ({
		info: {
			instanceId: "instance",
			releaseId: "v1.0.0",
			environmentId: options.preflight.environmentId ?? "data",
			uid: options.preflight.uid,
			canonicalAgentDir: options.preflight.agentDir,
		},
		disconnect: fixture.close,
		stopService: fixture.stop,
		invoke: vi.fn(),
	}));
	manager = new RemoteConnectionManager();
});
afterEach(async () => {
	await manager.shutdown();
	vi.useRealTimers();
	vi.restoreAllMocks();
	await rm(fixture.directory, { recursive: true, force: true });
});

describe("saved SSH intent and identity", () => {
	it("saves an unbound bookmark without running SSH, then commits its stable identity", async () => {
		const id = await add();
		expect(fixture.probe).not.toHaveBeenCalled();
		expect((await manager.getCatalog()).records[0]).not.toHaveProperty("binding");
		const ready = await manager.connect(await command(id));
		expect(ready).toMatchObject({
			state: "connected",
			connectionId: id,
			environment: { connectionId: id, environmentId: "data" },
		});
		expect((await manager.getCatalog()).lastSuccessfulConnectionId).toBe(id);
	});
	it("rejects stale and duplicate additions and keeps connected state revision independent", async () => {
		await connect();
		const status = await manager.getStatus(),
			catalog = await manager.getCatalog();
		const request = {
			epoch: catalog.epoch,
			generation: status.generation ?? 0,
			catalogRevision: catalog.revision,
			alias: "other",
		};
		await manager.add(request);
		expect((await manager.getStatus()).revision).toBe(status.revision);
		await expect(manager.add(request)).rejects.toThrow();
		expect((await manager.getCatalog()).records).toHaveLength(2);
	});
	it("refuses a changed preflight data identity without opening a transport", async () => {
		await connect();
		await disconnect();
		fixture.connect.mockClear();
		fixture.probe.mockResolvedValue({ ...probe, environmentId: undefined });
		await expect(connect()).rejects.toThrow("identity changed");
		expect(fixture.connect).not.toHaveBeenCalled();
		expect((await manager.getStatus()).errorKind).toBe("identity");
	});
	it("rejects changed effective SSH targets and handshake identities", async () => {
		await connect();
		await disconnect();
		fixture.connect.mockClear();
		fixture.probe.mockResolvedValue({ ...probe, target: { ...probe.target, hostname: "new-host" } });
		await expect(connect()).rejects.toThrow("identity changed");
		expect(fixture.connect).not.toHaveBeenCalled();
		fixture.probe.mockResolvedValue(probe);
		fixture.connect.mockResolvedValueOnce({
			info: { uid: 1, environmentId: "data", canonicalAgentDir: probe.agentDir },
			disconnect: fixture.close,
		});
		await expect(connect()).rejects.toThrow("identity changed");
	});
	it("does not default corrupted JSON or unknown versions to an empty catalog", async () => {
		await writeFile(`${fixture.directory}/remote-connection.json`, "{broken");
		expect(await manager.getCatalog()).toMatchObject({ errorKind: "corrupted" });
		expect(await manager.getStatus()).toMatchObject({ state: "error" });
		manager.startAutoConnect(async () => {});
		await Promise.resolve();
		expect(fixture.probe).not.toHaveBeenCalled();
	});
	it("requires a separate effective target confirmation for legacy bindings", async () => {
		await writeFile(
			`${fixture.directory}/remote-connection.json`,
			JSON.stringify({
				connectionId: "old",
				alias: "dev",
				environmentId: "data",
				uid: 1000,
				canonicalAgentDir: probe.agentDir,
				node: probe.node,
			}),
		);
		const status = await connect();
		expect(status.targetConfirmation?.target).toEqual(probe.target);
		expect(fixture.connect).not.toHaveBeenCalled();
		await manager.confirmTarget({ ...(await command()), token: status.targetConfirmation?.token ?? "" });
		expect((await manager.getStatus()).environment?.connectionId).toBe("old");
	});
	it("rejects a late success after a cancellation without changing the last-success pointer", async () => {
		const wait = deferred<unknown>();
		fixture.connect.mockImplementationOnce(() => wait.promise);
		const id = await add(),
			initial = await command(id);
		const connecting = manager.connect(initial);
		await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalled());
		let cancelled = false;
		const cancellation = disconnect().then(() => {
			cancelled = true;
		});
		try {
			await vi.waitFor(async () => expect(await manager.getStatus()).toMatchObject({ phase: "cancelling" }));
			expect(cancelled).toBe(false);
			await expect(manager.connect(await command(id))).rejects.toThrow();
		} finally {
			wait.resolve({
				info: {
					instanceId: "late",
					environmentId: "data",
					uid: probe.uid,
					canonicalAgentDir: probe.agentDir,
				},
				disconnect: fixture.close,
			});
			await connecting;
			await cancellation;
		}
		expect((await manager.getCatalog()).lastSuccessfulConnectionId).toBeNull();
		expect((await manager.getStatus()).state).toBe("disconnected");
	});
	it("waits for an earlier successful commit before acknowledging cancellation", async () => {
		const id = await add(),
			gate = deferred<void>(),
			original = JsonStore.prototype.write;
		const entered = deferred<void>();
		vi.spyOn(JsonStore.prototype, "write").mockImplementationOnce(async function (
			this: JsonStore<unknown>,
			value,
		) {
			entered.resolve();
			await gate.promise;
			return original.call(this, value);
		});
		const pending = manager.connect(await command(id));
		await entered.promise;
		let cancelled = false;
		const cancel = manager.disconnect(await command()).then(() => {
			cancelled = true;
		});
		await Promise.resolve();
		expect(cancelled).toBe(false);
		gate.resolve();
		await pending;
		await cancel;
		expect((await manager.getCatalog()).lastSuccessfulConnectionId).toBe(id);
		expect((await manager.getStatus()).state).toBe("disconnected");
	});
	it("does not attach an executable route when the binding write fails", async () => {
		const id = await add();
		vi.spyOn(JsonStore.prototype, "write").mockRejectedValueOnce(new Error("disk full"));
		await expect(manager.connect(await command(id))).rejects.toThrow("disk full");
		expect(fixture.attach).not.toHaveBeenCalled();
		expect(fixture.close).toHaveBeenCalled();
	});
});

describe("multiple bookmarks and one active connection", () => {
	it("requires atomic switch authorization and never sends the old environment while connecting another host", async () => {
		const a = await connect();
		const b = await add("other");
		await expect(manager.connect(await command(b))).rejects.toThrow();
		const pending = deferred<unknown>();
		fixture.connect.mockImplementationOnce(() => pending.promise);
		const switching = manager.switchConnection({
			...(await command(b)),
			currentConnectionId: a.connectionId ?? "",
		});
		await vi.waitFor(() => expect((fixture.connect.mock.calls.at(-1) ?? [])[0]).toBe("other"));
		expect((await manager.getStatus()).environment).toBeUndefined();
		pending.resolve({
			info: { instanceId: "other", uid: probe.uid, environmentId: "data", canonicalAgentDir: probe.agentDir },
			disconnect: fixture.close,
			stopService: fixture.stop,
		});
		await switching;
		expect((await manager.getStatus()).connectionId).toBe(b);
		expect(fixture.stop).not.toHaveBeenCalled();
	});
	it("a failed switch does not fall back or replace the last successful record", async () => {
		const a = await connect(),
			b = await add("other");
		fixture.probe.mockRejectedValueOnce(new Error("Permission denied"));
		await expect(
			manager.switchConnection({ ...(await command(b)), currentConnectionId: a.connectionId ?? "" }),
		).rejects.toThrow();
		expect((await manager.getStatus()).connectionId).toBe(b);
		expect((await manager.getCatalog()).lastSuccessfulConnectionId).toBe(a.connectionId);
	});
	it("reconnect opens a new transport and rejects a previously captured disconnect", async () => {
		await connect();
		const old = await command();
		await manager.reconnect(old);
		expect(fixture.connect).toHaveBeenCalledTimes(2);
		await expect(manager.disconnect(old)).rejects.toThrow("changed");
	});
	it("removing another record does not disconnect the current host, removing the last pointer clears it", async () => {
		const a = await connect(),
			b = await add("other");
		await manager.forget({ ...(await command(b)), recordRevision: 0 });
		expect((await manager.getStatus()).state).toBe("connected");
		const record = (await manager.getCatalog()).records[0]!;
		await manager.forget({ ...(await command(a.connectionId)), recordRevision: record.revision });
		expect((await manager.getCatalog()).lastSuccessfulConnectionId).toBeNull();
		expect(fixture.stop).not.toHaveBeenCalled();
	});
	it("forwards only current live events with a desktop generation boundary", async () => {
		await connect();
		const status = await manager.getStatus();
		const options = fixture.connect.mock.calls[0]![1];
		options.onEvent("onEvent", { sessionId: "one", event: { type: "agent_start" } });
		expect(fixture.observe).toHaveBeenCalledTimes(1);
		expect(fixture.send).toHaveBeenCalledWith("pi:event", expect.anything(), status.environment, {
			epoch: status.epoch,
			generation: status.generation,
		});
		await disconnect();
		options.onEvent("onEvent", { sessionId: "old" });
		expect(fixture.observe).toHaveBeenCalledTimes(1);
	});
	it("derives auth maintenance instructions from the original identity, not the active alias", async () => {
		const ready = await connect();
		const original = ready.environment!;
		const b = await add("other");
		await manager.switchConnection({ ...(await command(b)), currentConnectionId: ready.connectionId! });
		expect((await manager.authGuide(original)).sshCommand).toBe("ssh dev");
		await expect(manager.authGuide({ ...original, environmentId: "different" })).rejects.toThrow(
			"this environment",
		);
	});
});

describe("installation, retries and explicit stop", () => {
	it("downloads a missing runtime but requires a single-use confirmation before installing", async () => {
		fixture.probe.mockResolvedValue({ ...probe, installed: false });
		const distribution = {
			manifest: vi.fn().mockResolvedValue(manifest),
			download: vi.fn().mockResolvedValue("/isolated/archive"),
			install: vi.fn().mockImplementation(async () => {
				fixture.probe.mockResolvedValue(probe);
			}),
		};
		manager = new RemoteConnectionManager(distribution as never);
		const ready = await connect();
		expect(distribution.install).not.toHaveBeenCalled();
		const confirm = { ...(await command()), token: ready.installation?.token ?? "" };
		await expect(manager.installAndConnect({ ...confirm, token: "wrong" })).rejects.toThrow("expired");
		await expect(manager.connect(await command())).rejects.toThrow();
		await manager.installAndConnect(confirm);
		expect(distribution.install).toHaveBeenCalledTimes(1);
		await expect(manager.installAndConnect(confirm)).rejects.toThrow();
	});
	it("cancellation invalidates the old installation confirmation", async () => {
		fixture.probe.mockResolvedValue({ ...probe, installed: false });
		const distribution = {
			manifest: vi.fn().mockResolvedValue(manifest),
			download: vi.fn().mockResolvedValue("/isolated/archive"),
			install: vi.fn(),
		};
		manager = new RemoteConnectionManager(distribution as never);
		const ready = await connect(),
			confirm = { ...(await command()), token: ready.installation?.token ?? "" };
		await disconnect();
		await expect(manager.installAndConnect(confirm)).rejects.toThrow();
		expect(distribution.install).not.toHaveBeenCalled();
	});
	it("keeps the slot occupied until cancelled installation work has released local resources", async () => {
		fixture.probe.mockResolvedValue({ ...probe, installed: false });
		const gate = deferred<void>();
		const distribution = {
			manifest: vi.fn().mockResolvedValue(manifest),
			download: vi.fn().mockResolvedValue("/isolated/archive"),
			install: vi.fn(() => gate.promise),
		};
		manager = new RemoteConnectionManager(distribution as never);
		const ready = await connect();
		const installation = manager.installAndConnect({
			...(await command()),
			token: ready.installation?.token ?? "",
		});
		await vi.waitFor(() => expect(distribution.install).toHaveBeenCalled());
		const cancellation = disconnect();
		try {
			await vi.waitFor(async () => expect(await manager.getStatus()).toMatchObject({ phase: "cancelling" }));
			await expect(manager.connect(await command())).rejects.toThrow();
		} finally {
			gate.resolve();
			await installation;
			await cancellation;
		}
		expect(await manager.getStatus()).toMatchObject({ state: "disconnected", cancelledUncertain: true });
		expect(fixture.connect).not.toHaveBeenCalled();
	});

	it("connects an installed runtime without consulting a release manifest", async () => {
		const distribution = { manifest: vi.fn(), download: vi.fn(), install: vi.fn() };
		manager = new RemoteConnectionManager(distribution as never);
		await connect();
		expect(distribution.manifest).not.toHaveBeenCalled();
	});
	it("only restores the last successful bound host and never downloads a missing runtime in background", async () => {
		await connect();
		await manager.shutdown();
		fixture.connect.mockClear();
		fixture.probe.mockResolvedValue({ ...probe, installed: false });
		const distribution = { manifest: vi.fn(), download: vi.fn(), install: vi.fn() };
		manager = new RemoteConnectionManager(distribution as never);
		manager.startAutoConnect(async () => {});
		await vi.waitFor(async () => expect((await manager.getStatus()).state).toBe("error"));
		expect(fixture.probe).toHaveBeenLastCalledWith("dev", expect.anything());
		expect(distribution.download).not.toHaveBeenCalled();
	});
	it("reports cancellation of an in-flight read-only check", async () => {
		const id = await add(),
			pending = deferred<SshPreflight>();
		fixture.probe.mockImplementationOnce(() => pending.promise);
		const checking = manager.preflight(await command(id));
		const rejection = expect(checking).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(fixture.probe).toHaveBeenCalled());
		const cancellation = disconnect();
		await vi.waitFor(async () => expect(await manager.getStatus()).toMatchObject({ phase: "cancelling" }));
		pending.resolve(probe);
		await cancellation;
		await rejection;
		expect((await manager.getStatus()).state).toBe("disconnected");
	});
	it("bounds network retries, but stops attempting after cancellation", async () => {
		const id = await add();
		vi.useFakeTimers();
		fixture.probe.mockRejectedValue(new Error("SSH connection closed"));
		await expect(manager.connect(await command(id))).rejects.toThrow();
		expect((await manager.getStatus()).state).toBe("reconnecting");
		await vi.runAllTimersAsync();
		expect(fixture.probe).toHaveBeenCalledTimes(6);
		await expect(manager.connect(await command())).rejects.toThrow();
		await disconnect();
		await vi.runAllTimersAsync();
		expect(fixture.probe).toHaveBeenCalledTimes(7);
	});
	it("does not claim a stop until remote ownership release is confirmed", async () => {
		await connect();
		const pending = deferred<void>();
		fixture.stop.mockImplementationOnce(() => pending.promise);
		const old = await command(),
			stopping = manager.stopService(old);
		await vi.waitFor(async () => expect((await manager.getStatus()).state).toBe("stopping"));
		await expect(manager.disconnect(old)).rejects.toThrow("stop");
		await expect(
			manager.forget({ ...old, recordRevision: (await manager.getCatalog()).records[0]!.revision }),
		).rejects.toThrow("stop");
		pending.resolve();
		expect(await stopping).toMatchObject({ state: "disconnected", serviceStopped: true });
	});
	it("a failed stop remains explicitly unconfirmed", async () => {
		await connect();
		fixture.stop.mockRejectedValueOnce(new Error("owner may still be running"));
		await expect(manager.stopService(await command())).rejects.toThrow();
		expect(await manager.getStatus()).toMatchObject({ state: "error", stopUnconfirmed: true });
	});
	it("catalog writes remain real JSON and contain no credentials", async () => {
		await connect();
		const disk = JSON.parse(await readFile(`${fixture.directory}/remote-connection.json`, "utf8"));
		expect(disk.version).toBe(2);
		expect(disk.records[0].binding.target).toEqual(probe.target);
		expect(disk).not.toHaveProperty("installation");
	});
});
