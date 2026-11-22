import { type EnvironmentRef, environmentEntityKey } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	disconnect: vi.fn(),
	preflight: vi.fn(),
	remoteAdd: vi.fn(),
	closeSettings: vi.fn(),
	getCatalog: vi.fn(),
	getStatus: vi.fn(),
	onCatalog: vi.fn(),
	onStatus: vi.fn(),
	validate: vi.fn(),
	trust: vi.fn(),
	add: vi.fn(),
	select: vi.fn(),
	draft: vi.fn(),
	target: null as string | null,
}));
vi.mock("../api", () => ({
	getPi: () => ({
		remoteDisconnect: fixture.disconnect,
		remotePreflight: fixture.preflight,
		remoteAdd: fixture.remoteAdd,
		remoteGetCatalog: fixture.getCatalog,
		remoteGetStatus: fixture.getStatus,
		onRemoteCatalog: fixture.onCatalog,
		onRemoteConnectionStatus: fixture.onStatus,
		forEnvironment: () => ({ validateProjectDirectory: fixture.validate, ensureProjectTrust: fixture.trust }),
	}),
}));
vi.mock("./projects", () => ({
	useProjectsStore: {
		getState: () => ({ addKnownProject: fixture.add, select: fixture.select, load: vi.fn() }),
	},
}));
vi.mock("./sessions", () => ({
	invalidateEnvironmentSessions: vi.fn(),
	synchronizeEnvironmentSessions: vi.fn(),
	useSessionsStore: {
		getState: () => ({ activateNewSessionDraftForCwd: fixture.draft, loadModels: vi.fn() }),
	},
}));
vi.mock("./interactions", () => ({
	useInteractionStore: {
		getState: () => ({
			foregroundTrustCwd: fixture.target,
			setTrustTarget: (target: string | null) => {
				fixture.target = target;
			},
		}),
	},
}));

vi.mock("./toasts", () => ({ pushToast: vi.fn() }));
vi.mock("./settings", () => ({ useSettingsStore: { getState: () => ({ setOpen: fixture.closeSettings }) } }));

import { initRemoteConnectionBridge, useRemoteConnectionStore } from "./remote-connection";
import { claimActivation } from "./session-navigation";
import { invalidateEnvironmentSessions, synchronizeEnvironmentSessions } from "./sessions";

const environment: EnvironmentRef = { kind: "ssh", connectionId: "company", environmentId: "data" };
beforeEach(() => {
	vi.clearAllMocks();
	fixture.target = null;
	fixture.validate.mockResolvedValue("/literal %2F [project] ");
	fixture.trust.mockResolvedValue(true);
	useRemoteConnectionStore.setState({
		open: true,
		status: { revision: 1, state: "connected", environment, alias: "company" },
	});
});
afterEach(() => {
	const store = useRemoteConnectionStore.getState();
	store.accept({ revision: store.status.revision + 1, state: "disconnected" });
	if (vi.isFakeTimers()) vi.useRealTimers();
});

describe("remote command capture", () => {
	it("reads the fresh result and retains each host's last check without borrowing another host's data", async () => {
		const catalog = {
			epoch: "run",
			revision: 1,
			records: [
				{ connectionId: "a", alias: "alpha", revision: 0 },
				{ connectionId: "b", alias: "beta", revision: 0 },
			],
			lastSuccessfulConnectionId: null,
		};
		const status = {
			epoch: "run",
			revision: 1,
			generation: 1,
			connectionId: "a",
			state: "disconnected" as const,
		};
		const preflight = {
			alias: "alpha",
			target: { hostname: "fresh-a", user: "dev", port: "2222" },
			uid: 1000,
			home: "/home/dev",
			node: "/usr/bin/node",
			nodeVersion: "22.19.0",
			platform: "linux",
			arch: "arm64",
			glibc: "2.35",
			commands: { sh: true, tar: true, sha256sum: true, flock: true, setsid: true },
			installed: true,
			agentDir: "/home/dev/.percho/agent",
			installedReleaseId: "v2.0.0",
		};
		useRemoteConnectionStore.setState({ catalog, status });
		fixture.preflight.mockResolvedValueOnce(preflight);
		fixture.getStatus.mockResolvedValueOnce({ ...status, generation: 2, revision: 3, preflight });
		await useRemoteConnectionStore.getState().preflight({ epoch: "run", generation: 1, connectionId: "a" });
		expect(useRemoteConnectionStore.getState().status.preflight?.target.hostname).toBe("fresh-a");
		expect(useRemoteConnectionStore.getState().getLastCheck("a")?.installedReleaseId).toBe("v2.0.0");
		useRemoteConnectionStore.getState().accept({ ...status, connectionId: "b", generation: 3, revision: 4 });
		expect(useRemoteConnectionStore.getState().getLastCheck("a")?.target.hostname).toBe("fresh-a");
		expect(useRemoteConnectionStore.getState().getLastCheck("b")).toBeUndefined();
		useRemoteConnectionStore
			.getState()
			.accept({ ...status, revision: 2, preflight: { ...preflight, installedReleaseId: "old" } });
		expect(useRemoteConnectionStore.getState().getLastCheck("a")?.installedReleaseId).toBe("v2.0.0");
		useRemoteConnectionStore
			.getState()
			.acceptCatalog({ ...catalog, revision: 2, records: [catalog.records[1]!] });
		expect(useRemoteConnectionStore.getState().getLastCheck("a")).toBeUndefined();
	});
	it("saves a record with the observed catalog and slot without connecting", async () => {
		const catalog = { epoch: "run", revision: 1, records: [], lastSuccessfulConnectionId: null };
		const updated = {
			...catalog,
			revision: 2,
			records: [{ connectionId: "saved", alias: "host", revision: 1 }],
		};
		useRemoteConnectionStore.setState({
			catalog,
			status: { revision: 1, state: "disconnected", epoch: "run", generation: 3 },
		});
		fixture.remoteAdd.mockResolvedValueOnce({ connectionId: "saved", catalog: updated });
		await expect(useRemoteConnectionStore.getState().add("host")).resolves.toBe("saved");
		expect(fixture.remoteAdd).toHaveBeenCalledWith({
			epoch: "run",
			generation: 3,
			catalogRevision: 1,
			alias: "host",
		});
		expect(useRemoteConnectionStore.getState().catalog).toEqual(updated);
	});
	it("passes the confirmed command unchanged after the slot changes", async () => {
		const command = { epoch: "run", generation: 1, connectionId: "old" };
		fixture.disconnect.mockRejectedValueOnce(new Error("stale"));
		useRemoteConnectionStore.setState({
			status: { revision: 4, state: "connected", epoch: "run", generation: 2, connectionId: "new" },
		});
		await expect(useRemoteConnectionStore.getState().disconnect(command)).rejects.toThrow("stale");
		expect(fixture.disconnect).toHaveBeenCalledWith(command);
	});
	it("captures the exact saved record and observed slot generation", () => {
		useRemoteConnectionStore.setState({
			catalog: {
				epoch: "run",
				revision: 2,
				records: [{ connectionId: "saved", alias: "host", revision: 1 }],
				lastSuccessfulConnectionId: null,
			},
			status: { revision: 3, state: "disconnected", epoch: "run", generation: 7 },
		});
		expect(useRemoteConnectionStore.getState().capture("saved")).toEqual({
			epoch: "run",
			generation: 7,
			connectionId: "saved",
		});
		expect(() => useRemoteConnectionStore.getState().capture("host")).toThrow();
	});
});

describe("remote bridge", () => {
	it("retains initialization failures for display", async () => {
		fixture.onCatalog.mockReturnValue(() => {});
		fixture.onStatus.mockReturnValue(() => {});
		fixture.getCatalog.mockRejectedValueOnce(new Error("catalog failed"));
		fixture.getStatus.mockRejectedValueOnce(new Error("status failed"));
		useRemoteConnectionStore.setState({
			catalog: { epoch: "", revision: -1, records: [], lastSuccessfulConnectionId: null },
			status: { revision: -1, state: "disconnected" },
		});
		const off = initRemoteConnectionBridge();
		await Promise.resolve();
		await Promise.resolve();
		expect(useRemoteConnectionStore.getState().catalog.error).toContain("catalog failed");
		expect(useRemoteConnectionStore.getState().status.error).toContain("status failed");
		off();
	});
	it("does not let late baselines replace newer catalog and status events", async () => {
		let catalogEvent!: (value: ReturnType<typeof useRemoteConnectionStore.getState>["catalog"]) => void;
		let statusEvent!: (value: ReturnType<typeof useRemoteConnectionStore.getState>["status"]) => void;
		let finishCatalog!: (value: ReturnType<typeof useRemoteConnectionStore.getState>["catalog"]) => void;
		let finishStatus!: (value: ReturnType<typeof useRemoteConnectionStore.getState>["status"]) => void;
		fixture.onCatalog.mockImplementation((fn) => {
			catalogEvent = fn;
			return () => {};
		});
		fixture.onStatus.mockImplementation((fn) => {
			statusEvent = fn;
			return () => {};
		});
		fixture.getCatalog.mockReturnValue(
			new Promise((resolve) => {
				finishCatalog = resolve;
			}),
		);
		fixture.getStatus.mockReturnValue(
			new Promise((resolve) => {
				finishStatus = resolve;
			}),
		);
		useRemoteConnectionStore.setState({
			catalog: { epoch: "", revision: -1, records: [], lastSuccessfulConnectionId: null },
			status: { revision: -1, state: "disconnected" },
		});
		const off = initRemoteConnectionBridge();
		const catalog = { epoch: "run", revision: 2, records: [], lastSuccessfulConnectionId: null };
		catalogEvent(catalog);
		statusEvent({ epoch: "run", generation: 2, revision: 2, state: "disconnected" });
		finishCatalog({ ...catalog, revision: 1 });
		finishStatus({ epoch: "run", generation: 1, revision: 1, state: "disconnected" });
		await Promise.resolve();
		expect(useRemoteConnectionStore.getState().catalog.revision).toBe(2);
		expect(useRemoteConnectionStore.getState().status.generation).toBe(2);
		off();
	});
});

describe("remote synchronization recovery", () => {
	it("retries a failed read-only summary with a fresh generation, without unpausing failed state", async () => {
		vi.useFakeTimers();
		vi.mocked(invalidateEnvironmentSessions).mockReturnValueOnce(1).mockReturnValueOnce(2);
		vi.mocked(synchronizeEnvironmentSessions)
			.mockRejectedValueOnce(new Error("temporary summary failure"))
			.mockResolvedValueOnce(undefined);
		useRemoteConnectionStore.setState({ status: { revision: 1, state: "disconnected" } });
		useRemoteConnectionStore.getState().accept({ revision: 2, state: "connected", environment });
		await Promise.resolve();
		expect(synchronizeEnvironmentSessions).toHaveBeenCalledWith(environment, 1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(synchronizeEnvironmentSessions).toHaveBeenLastCalledWith(environment, 2);
		expect(synchronizeEnvironmentSessions).toHaveBeenCalledTimes(2);
	});
	it("cancels a pending retry when the connection disappears without an environment", async () => {
		vi.useFakeTimers();
		vi.mocked(synchronizeEnvironmentSessions).mockRejectedValueOnce(new Error("offline"));
		useRemoteConnectionStore.setState({ status: { revision: 1, state: "disconnected" } });
		useRemoteConnectionStore.getState().accept({ revision: 2, state: "connected", environment });
		await Promise.resolve();
		useRemoteConnectionStore.getState().accept({ revision: 3, state: "disconnected" });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(synchronizeEnvironmentSessions).toHaveBeenCalledTimes(1);
		expect(invalidateEnvironmentSessions).toHaveBeenLastCalledWith(environment);
	});
});

describe("remote project entry", () => {
	it("does not add or navigate to a project when trust is denied", async () => {
		fixture.trust.mockResolvedValue(false);
		await useRemoteConnectionStore.getState().openProject("/untrusted");
		expect(fixture.add).not.toHaveBeenCalled();
		expect(fixture.select).not.toHaveBeenCalled();
		expect(fixture.closeSettings).not.toHaveBeenCalled();
	});
	it("does not open trust after the connection generation changes", async () => {
		let finish!: (path: string) => void;
		fixture.validate.mockReturnValue(
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
		);
		useRemoteConnectionStore.setState({
			status: { revision: 1, state: "connected", environment, epoch: "run", generation: 1 },
		});
		const opening = useRemoteConnectionStore.getState().openProject("/old");
		useRemoteConnectionStore
			.getState()
			.accept({ revision: 2, state: "connected", environment, epoch: "run", generation: 2 });
		finish("/old");
		await opening;
		expect(fixture.trust).not.toHaveBeenCalled();
	});
	it("validates literal paths on the target before trust and binds the resulting project once", async () => {
		await useRemoteConnectionStore.getState().openProject("/literal %2F [project] ");
		expect(fixture.validate).toHaveBeenCalledWith({ path: "/literal %2F [project] " });
		expect(fixture.trust).toHaveBeenCalledWith({ cwd: "/literal %2F [project] " });
		const cwd = environmentEntityKey(environment, "/literal %2F [project] ");
		expect(fixture.select).toHaveBeenCalledWith(cwd);
		expect(fixture.draft).toHaveBeenCalledWith(cwd, environment);
		expect(fixture.closeSettings).toHaveBeenCalledWith(false);
		expect(fixture.target).toBeNull();
	});
	it("closing the entry while validation is in flight does not reopen trust or add a project", async () => {
		let finish!: (path: string) => void;
		fixture.validate.mockReturnValue(
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
		);
		const opening = useRemoteConnectionStore.getState().openProject("/old");
		useRemoteConnectionStore.getState().setOpen(false);
		finish("/old");
		await opening;
		expect(fixture.trust).not.toHaveBeenCalled();
		expect(fixture.add).not.toHaveBeenCalled();
	});
	it("late trust can register its original project but cannot steal a newer navigation", async () => {
		let finish!: (trusted: boolean) => void, entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		fixture.trust.mockImplementation(() => {
			entered();
			return new Promise<boolean>((resolve) => {
				finish = resolve;
			});
		});
		const opening = useRemoteConnectionStore.getState().openProject("/old");
		await waiting;
		claimActivation();
		finish(true);
		await opening;
		expect(fixture.add).toHaveBeenCalledOnce();
		expect(fixture.select).not.toHaveBeenCalled();
		expect(fixture.draft).not.toHaveBeenCalled();
	});
});
