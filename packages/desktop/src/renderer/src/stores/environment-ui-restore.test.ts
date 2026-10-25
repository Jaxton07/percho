import { environmentEntityKey, LOCAL_ENVIRONMENT, parseEnvironmentUiState } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand";

const fixture = vi.hoisted(() => ({
	cleanup: [] as (() => void)[],
	reset: [] as (() => void)[],
	read: vi.fn(),
	save: vi.fn(),
	loaded: vi.fn(),
	open: vi.fn(),
	switch: vi.fn(),
	load: vi.fn(),
}));
function trackStore<T>(store: StoreApi<T>): StoreApi<T> {
	const subscribe = store.subscribe;
	store.subscribe = (listener) => {
		const off = subscribe(listener);
		fixture.cleanup.push(off);
		return off;
	};
	fixture.reset.push(() => store.setState(store.getInitialState(), true));
	return store;
}
vi.mock("../api", () => ({
	getPi: () => ({ loadEnvironmentUiState: fixture.read, saveEnvironmentUiState: fixture.save }),
}));
vi.mock("../environment-api", () => ({ getExecutionApi: () => ({ getLoadedSessions: fixture.loaded }) }));
vi.mock("./projects", async () => {
	const { create } = await import("zustand");
	return {
		useProjectsStore: trackStore(
			create(() => ({ addedProjects: ["/legacy"], allSessions: [], load: fixture.load })),
		),
	};
});
vi.mock("./ui-preferences", async () => {
	const { create } = await import("zustand");
	return {
		useUiPreferencesStore: trackStore(
			create(() => ({
				pinnedSessions: ["legacy"],
				pinnedProjects: ["/legacy"],
				expandedGroups: ["/legacy"],
				expandedGroupsTouched: false,
				lastCwd: "/legacy",
			})),
		),
	};
});
vi.mock("./session-workspace", async () => {
	const { create } = await import("zustand");
	return {
		isWorkspaceRecording: () => true,
		useSessionWorkspaceStore: trackStore(create(() => ({ members: [], activeFile: null, recentFile: null }))),
	};
});
vi.mock("./sessions", async () => {
	const { create } = await import("zustand");
	return {
		useSessionsStore: trackStore(
			create(() => ({
				sessions: [],
				activeSessionId: null,
				openFromHistory: fixture.open,
				switchSession: fixture.switch,
			})),
		),
	};
});
vi.mock("./remote-connection", async () => {
	const { create } = await import("zustand");
	return { useRemoteConnectionStore: trackStore(create(() => ({ status: { state: "disconnected" } }))) };
});
const remote = { kind: "ssh", connectionId: "company", environmentId: "data" } as const;
const key = (value: string) => environmentEntityKey(remote, value);
const snapshot = () => ({
	version: 1,
	projects: ["/local", key("/remote")],
	pinnedSessions: [key("remote-id"), "local-id"],
	pinnedProjects: [key("/remote"), "/local"],
	expandedGroups: [],
	expandedGroupsTouched: true,
	lastCwd: key("/remote"),
	workspace: {
		members: [
			{ file: key("/remote/r.jsonl"), sessionId: key("remote-id") },
			{ file: "/local/l.jsonl", sessionId: "local-id" },
		],
		activeFile: key("/remote/r.jsonl"),
		recentFile: "/local/l.jsonl",
	},
	catalog: [
		{
			sessionId: key("remote-id"),
			sessionFile: key("/remote/r.jsonl"),
			cwd: key("/remote"),
			createdAt: 1,
			messageCount: 0,
			active: true,
			permissionMode: "fullAccess",
			secret: "must-not-persist",
		},
	],
});
beforeEach(() => {
	for (const off of fixture.cleanup.splice(0)) off();
	for (const reset of fixture.reset) reset();
	vi.resetModules();
	vi.clearAllMocks();
	fixture.read.mockResolvedValue(parseEnvironmentUiState(snapshot()));
	fixture.save.mockResolvedValue(undefined);
	fixture.load.mockResolvedValue(undefined);
	fixture.loaded.mockResolvedValue([]);
});
async function stores() {
	return {
		projects: (await import("./projects")).useProjectsStore,
		prefs: (await import("./ui-preferences")).useUiPreferencesStore,
		workspace: (await import("./session-workspace")).useSessionWorkspaceStore,
		remote: (await import("./remote-connection")).useRemoteConnectionStore,
	};
}
describe("mixed navigation cold start", () => {
	it("restores the single mixed order and explicit empty expansion, retaining offline references", async () => {
		const api = await import("./environment-ui-restore");
		await api.initEnvironmentUiState();
		const s = await stores();
		expect(s.workspace.getState().members.map((item) => item.file)).toEqual(
			snapshot().workspace.members.map((item) => item.file),
		);
		expect(s.prefs.getState().expandedGroups).toEqual([]);
		expect(s.prefs.getState().expandedGroupsTouched).toBe(true);
		api.restoreEnvironmentUiNavigation();
		await Promise.resolve();
		expect(fixture.loaded).not.toHaveBeenCalled();
		expect(s.projects.getState().addedProjects).toContain(key("/remote"));
		const saved = fixture.save.mock.calls.at(-1)?.[0].state;
		expect(JSON.stringify(saved)).not.toContain("must-not-persist");
		expect(saved.catalog[0].active).toBe(false);
	});
	it("late connection cannot override a newer local navigation or bind old projects to a replacement", async () => {
		const api = await import("./environment-ui-restore");
		await api.initEnvironmentUiState();
		api.restoreEnvironmentUiNavigation();
		const s = await stores();
		(await import("./session-navigation")).noteUserIntent();
		s.remote.setState({ status: { revision: 1, state: "connected", environment: remote } });
		await vi.waitFor(() => expect(fixture.loaded).toHaveBeenCalledOnce());
		await Promise.resolve();
		expect(fixture.open).not.toHaveBeenCalled();
		expect(fixture.switch).not.toHaveBeenCalled();
		s.remote.setState({
			status: { revision: 2, state: "connected", environment: { ...remote, environmentId: "replacement" } },
		});
		expect(s.projects.getState().addedProjects).toContain(key("/remote"));
	});
	it("restores a still-live zero-message registry entry instead of reopening a nonexistent history file", async () => {
		fixture.loaded.mockResolvedValue([{ meta: snapshot().catalog[0] }]);
		const api = await import("./environment-ui-restore");
		await api.initEnvironmentUiState();
		api.restoreEnvironmentUiNavigation();
		const s = await stores();
		s.remote.setState({ status: { revision: 1, state: "connected", environment: remote } });
		await vi.waitFor(() => expect(fixture.switch).toHaveBeenCalledWith(key("remote-id")));
		expect(fixture.open).not.toHaveBeenCalled();
	});
	it("does not publish an empty mixed authority before legacy restoration finishes", async () => {
		fixture.read.mockResolvedValue(null);
		const api = await import("./environment-ui-restore");
		await api.initEnvironmentUiState();
		const s = await stores();
		s.prefs.setState({ lastCwd: "/local" });
		expect(fixture.save).not.toHaveBeenCalled();
		s.workspace.setState({
			members: [{ file: "/legacy/a.jsonl", sessionId: "a" }],
			activeFile: "/legacy/a.jsonl",
		});
		api.startEnvironmentUiPersistence();
		expect(fixture.save.mock.calls[0]?.[0].state.workspace.members[0].file).toBe("/legacy/a.jsonl");
	});
	it("serializes mixed order writes and keeps the last reorder while a save is pending", async () => {
		let release!: () => void;
		fixture.save.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const api = await import("./environment-ui-restore");
		await api.initEnvironmentUiState();
		const s = await stores();
		const original = s.workspace.getState().members;
		s.workspace.setState({ members: [...original].reverse() });
		s.workspace.setState({ members: original });
		s.workspace.setState({ members: [...original].reverse() });
		expect(fixture.save).toHaveBeenCalledOnce();
		release();
		await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(2));
		expect(
			fixture.save.mock.calls[1]?.[0].state.workspace.members.map((item: { file: string }) => item.file),
		).toEqual([...original].reverse().map((item) => item.file));
	});
	it("rejects corrupted and cross-environment references without treating them as local", () => {
		expect(
			parseEnvironmentUiState({
				...snapshot(),
				workspace: { ...snapshot().workspace, members: [{ file: "/local/a", sessionId: key("remote-id") }] },
			}),
		).toBeNull();
		expect(parseEnvironmentUiState({ version: 2 })).toBeNull();
		expect(parseEnvironmentUiState(null)).toBeNull();
		expect(
			parseEnvironmentUiState({
				...snapshot(),
				projects: [environmentEntityKey(LOCAL_ENVIRONMENT, "percho-env-v1:literal")],
			})?.projects,
		).toHaveLength(1);
	});
});
