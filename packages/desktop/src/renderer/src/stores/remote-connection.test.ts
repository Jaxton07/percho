import { type EnvironmentRef, environmentEntityKey } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
	useProjectsStore: { getState: () => ({ addKnownProject: fixture.add, select: fixture.select }) },
}));
vi.mock("./sessions", () => ({
	invalidateEnvironmentSessions: vi.fn(),
	synchronizeEnvironmentSessions: vi.fn(),
	useSessionsStore: { getState: () => ({ activateNewSessionDraftForCwd: fixture.draft }) },
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

import { useRemoteConnectionStore } from "./remote-connection";
import { claimActivation } from "./session-navigation";

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
