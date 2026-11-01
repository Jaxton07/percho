import { type EnvironmentRef, environmentEntityKey } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	validate: vi.fn(),
	trust: vi.fn(),
	add: vi.fn(),
	select: vi.fn(),
	draft: vi.fn(),
	target: null as string | null,
}));
vi.mock("../api", () => ({
	getPi: () => ({
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

import { useRemoteConnectionStore } from "./remote-connection";
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
	it("validates literal paths on the target before trust and binds the resulting project once", async () => {
		await useRemoteConnectionStore.getState().openProject("/literal %2F [project] ");
		expect(fixture.validate).toHaveBeenCalledWith({ path: "/literal %2F [project] " });
		expect(fixture.trust).toHaveBeenCalledWith({ cwd: "/literal %2F [project] " });
		const cwd = environmentEntityKey(environment, "/literal %2F [project] ");
		expect(fixture.select).toHaveBeenCalledWith(cwd);
		expect(fixture.draft).toHaveBeenCalledWith(cwd, environment);
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
