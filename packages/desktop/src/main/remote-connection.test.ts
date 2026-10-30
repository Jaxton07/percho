import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	saved: null as unknown,
	probe: vi.fn(),
	connect: vi.fn(),
	detach: vi.fn(),
	close: vi.fn(),
	stop: vi.fn(),
	send: vi.fn(),
	observe: vi.fn(),
	detachNotices: vi.fn(),
}));
vi.mock("./task-notifications", () => ({
	observeTaskNotification: fixture.observe,
	taskNotificationObserver: { detach: fixture.detachNotices },
}));
vi.mock("electron", () => ({ app: { getPath: () => "/isolated-test-data" } }));
vi.mock("./ipc/send", () => ({ sendToRenderer: fixture.send }));
vi.mock("./environment-router", () => ({ environmentRouter: { attach: vi.fn(() => fixture.detach) } }));
vi.mock("@percho/backend", async () => {
	const { sshFailureKind, checkSshRequirements } = await import("../../../backend/src/runtime/ssh-preflight");
	return {
		JsonStore: class {
			async read() {
				return fixture.saved;
			}
			async update(fn: (value: unknown) => unknown) {
				fixture.saved = fn(fixture.saved);
				return fixture.saved;
			}
		},
		RemoteMutationUnknownError: class extends Error {},
		SshRuntimeConnection: { connect: fixture.connect },
		validateSshAlias: (alias: string) => {
			if (!/^[a-z][a-z0-9-]*$/.test(alias)) throw new Error("Invalid alias");
		},
		remoteAuthGuide: (alias: string, node: string) => ({
			sshCommand: `ssh ${alias}`,
			authCommand: `${node} auth`,
		}),
		preflightSsh: fixture.probe,
		checkSshRequirements,
		installSshRuntime: vi.fn(),
		sshFailureKind,
	};
});

import { RemoteConnectionManager } from "./remote-connection";

const probe = {
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
};
const info = {
	instanceId: "instance",
	environmentId: "data",
	uid: 1000,
	canonicalAgentDir: "/home/developer/.percho/agent",
};
let manager: RemoteConnectionManager;
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	fixture.saved = null;
	fixture.stop.mockResolvedValue(undefined);
	fixture.probe.mockResolvedValue(probe);
	fixture.connect.mockResolvedValue({
		info,
		disconnect: fixture.close,
		stopService: fixture.stop,
		invoke: vi.fn(),
	});
	manager = new RemoteConnectionManager();
});
afterEach(() => {
	manager.disconnect();
	vi.useRealTimers();
});

describe("remote connection intent and ownership", () => {
	it("forwards only current-connection live task events to notification observation", async () => {
		await manager.connect("dev");
		const callbacks = fixture.connect.mock.calls.at(-1)?.[1];
		const payload = { sessionId: "s", sequence: 1, event: { type: "agent_start" } };
		callbacks.onEvent("onEvent", payload);
		expect(fixture.observe).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "ssh", environmentId: "data" }),
			payload,
			expect.any(Function),
		);
		manager.disconnect();
		expect(fixture.detachNotices).toHaveBeenCalled();
		fixture.observe.mockClear();
		callbacks.onEvent("onEvent", payload);
		expect(fixture.observe).not.toHaveBeenCalled();
	});
	it("keeps a check read-only and cancelled checks cannot publish success", async () => {
		let finish!: (value: unknown) => void;
		fixture.probe.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const checking = manager.preflight("dev");
		manager.disconnect();
		finish(probe);
		await expect(checking).rejects.toThrow("cancelled");
		expect((await manager.getStatus()).state).toBe("disconnected");
		expect(fixture.connect).not.toHaveBeenCalled();
		expect(fixture.saved).toBeNull();
	});
	it("bounds network retries and an explicit disconnect prevents a queued retry", async () => {
		fixture.probe.mockRejectedValue(new Error("Connection timed out"));
		await expect(manager.connect("dev")).rejects.toThrow();
		expect((await manager.getStatus()).state).toBe("reconnecting");
		await vi.runAllTimersAsync();
		expect(fixture.probe).toHaveBeenCalledTimes(6);
		expect((await manager.getStatus()).state).toBe("error");
		await expect(manager.connect("dev")).rejects.toThrow();
		manager.disconnect();
		await vi.runAllTimersAsync();
		expect(fixture.probe).toHaveBeenCalledTimes(7);
	});
	it("does not retry authentication or changed effective target", async () => {
		fixture.probe.mockRejectedValueOnce(new Error("Permission denied (publickey)"));
		await expect(manager.connect("dev")).rejects.toThrow();
		await vi.runAllTimersAsync();
		expect(fixture.probe).toHaveBeenCalledTimes(1);
		fixture.saved = {
			connectionId: "saved",
			alias: "dev",
			...info,
			target: { ...probe.target, hostname: "old-server" },
		};
		await expect(manager.connect("dev")).rejects.toThrow("identity changed");
		expect(fixture.connect).not.toHaveBeenCalled();
		await vi.runAllTimersAsync();
		expect((await manager.getStatus()).errorKind).toBe("identity");
	});
	it("startup connects in background; removal only closes its bridge and preserves foreign identity", async () => {
		await manager.connect("dev");
		manager.disconnect();
		manager = new RemoteConnectionManager();
		manager.startAutoConnect(async () => {});
		await vi.advanceTimersByTimeAsync(0);
		expect((await manager.getStatus()).state).toBe("connected");
		await manager.forget();
		expect(fixture.saved).toBeNull();
		expect((await manager.getStatus()).environment).toBeUndefined();
		expect(fixture.close).toHaveBeenCalledTimes(2);
	});
});

it("a deliberate stop stays paused across bridge closure and waits for owner-release proof", async () => {
	let release!: () => void;
	fixture.stop.mockReturnValue(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	await manager.connect("dev");
	const stopped = manager.stopService();
	const callbacks = fixture.connect.mock.calls.at(-1)?.[1];
	callbacks.onClose();
	expect((await manager.getStatus()).state).toBe("stopping");
	await vi.runAllTimersAsync();
	expect(fixture.connect).toHaveBeenCalledTimes(1);
	await expect(manager.connect("dev")).rejects.toThrow("already being established");
	release();
	await stopped;
	expect((await manager.getStatus()).serviceStopped).toBe(true);
	await vi.runAllTimersAsync();
	expect(fixture.connect).toHaveBeenCalledTimes(1);
});

it("maintenance instructions remain bound to the original environment after disconnect", async () => {
	await manager.connect("dev");
	const environment = (await manager.getStatus()).environment;
	if (!environment) throw new Error("Fixture has no remote");
	manager.disconnect();
	expect((await manager.authGuide(environment)).agentDir).toBe(info.canonicalAgentDir);
	await expect(manager.authGuide({ ...environment, environmentId: "different" })).rejects.toThrow(
		"this environment",
	);
	await manager.forget();
	await expect(manager.authGuide(environment)).rejects.toThrow("this environment");
});

it("rejects malformed saved identities before auto-connecting or publishing them", async () => {
	fixture.saved = { alias: "dev", connectionId: 42 };
	expect(await manager.getStatus()).toMatchObject({ state: "error", errorKind: "identity" });
	manager.startAutoConnect(async () => {});
	await vi.advanceTimersByTimeAsync(0);
	expect(fixture.probe).not.toHaveBeenCalled();
	expect(fixture.connect).not.toHaveBeenCalled();
	await manager.forget();
	expect(fixture.saved).toBeNull();
});

it("downloads for manual installation but never installs without the matching one-use confirmation", async () => {
	const manifest = {
		releaseId: "v1.0.0",
		protocol: 3,
		artifacts: { arm64: { bytes: 42, sha256: "a".repeat(64) } },
	};
	const distribution = {
		manifest: vi.fn().mockResolvedValue(manifest),
		download: vi.fn().mockResolvedValue("/isolated/archive"),
		install: vi.fn().mockImplementation(async () => {
			fixture.probe.mockResolvedValue(probe);
		}),
	};
	manager = new RemoteConnectionManager(distribution as never);
	fixture.probe.mockResolvedValue({ ...probe, installed: false, serviceState: "stopped" });
	const ready = await manager.connect("dev");
	expect(ready.installation).toMatchObject({
		releaseId: "v1.0.0",
		directory: "/home/developer/.percho/releases/v1.0.0",
	});
	expect(distribution.install).not.toHaveBeenCalled();
	expect(fixture.connect).not.toHaveBeenCalled();
	await expect(manager.installAndConnect("wrong")).rejects.toThrow("expired");
	const token = ready.installation?.token ?? "";
	await manager.installAndConnect(token);
	expect(distribution.install).toHaveBeenCalledTimes(1);
	expect(fixture.connect).toHaveBeenCalledTimes(1);
	await expect(manager.installAndConnect(token)).rejects.toThrow("expired");
});
it("background connection never downloads or prompts for a missing runtime", async () => {
	const distribution = { manifest: vi.fn(), download: vi.fn(), install: vi.fn() };
	manager = new RemoteConnectionManager(distribution as never);
	fixture.probe.mockResolvedValue({ ...probe, installed: false, serviceState: "stopped" });
	await expect(manager.connect("dev", true)).rejects.toThrow("NOT_INSTALLED");
	expect(distribution.manifest).not.toHaveBeenCalled();
	expect(distribution.download).not.toHaveBeenCalled();
	await vi.runAllTimersAsync();
	expect(fixture.probe).toHaveBeenCalledTimes(1);
});
it("connects an installed runtime without reading the desired release manifest", async () => {
	const distribution = {
		manifest: vi.fn().mockRejectedValue(new Error("no new release available")),
		download: vi.fn(),
		install: vi.fn(),
	};
	manager = new RemoteConnectionManager(distribution as never);
	await manager.connect("dev");
	expect((await manager.getStatus()).state).toBe("connected");
	expect(distribution.manifest).not.toHaveBeenCalled();
});
it("cancelling or starting a fresh check invalidates an earlier installation confirmation", async () => {
	const distribution = {
		manifest: vi
			.fn()
			.mockResolvedValue({ releaseId: "v1.0.0", protocol: 3, artifacts: { arm64: { bytes: 42 } } }),
		download: vi.fn().mockResolvedValue("/isolated/archive"),
		install: vi.fn(),
	};
	manager = new RemoteConnectionManager(distribution as never);
	fixture.probe.mockResolvedValue({ ...probe, installed: false, serviceState: "stopped" });
	const ready = await manager.connect("dev");
	manager.disconnect();
	await expect(manager.installAndConnect(ready.installation?.token ?? "")).rejects.toThrow("expired");
	expect(distribution.install).not.toHaveBeenCalled();
});

it("a missing previous data identity cannot auto-initialize or rebind the saved environment", async () => {
	await manager.connect("dev");
	manager.disconnect();
	fixture.connect.mockClear();
	fixture.probe.mockResolvedValue({ ...probe, environmentId: undefined });
	await expect(manager.connect("dev")).rejects.toThrow("Remote identity changed");
	expect(fixture.connect).not.toHaveBeenCalled();
	expect((await manager.getStatus()).errorKind).toBe("identity");
	await vi.runAllTimersAsync();
	expect(fixture.connect).not.toHaveBeenCalled();
});
