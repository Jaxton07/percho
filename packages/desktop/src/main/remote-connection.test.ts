import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	saved: null as unknown,
	probe: vi.fn(),
	connect: vi.fn(),
	detach: vi.fn(),
	close: vi.fn(),
	stop: vi.fn(),
	send: vi.fn(),
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
		preflightSsh: fixture.probe,
		checkSshRequirements,
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
};
const info = {
	instanceId: "instance",
	environmentId: "data",
	uid: 1000,
	canonicalAgentDir: "/home/developer/.local/share/percho/agent",
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
