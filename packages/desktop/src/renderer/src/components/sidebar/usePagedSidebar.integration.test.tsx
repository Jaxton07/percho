// @vitest-environment happy-dom

import { type EnvironmentRef, environmentEntityKey, environmentKey, LOCAL_ENVIRONMENT } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { useSessionCatalogStore } from "../../stores/session-catalog";
import { useSessionsStore } from "../../stores/sessions";
import { usePagedSidebar } from "./usePagedSidebar";

const api = vi.hoisted(() => ({
	querySessionProjects: vi.fn(),
	querySessionCatalog: vi.fn(),
	onSessionCatalogChanged: vi.fn(() => () => {}),
	verifySessionCatalog: vi.fn(),
}));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => api }));
vi.mock("../../environment-registry", () => ({
	getEnvironments: () => environments,
	onEnvironmentsChanged: () => () => {},
}));
const remote = { kind: "ssh", connectionId: "host", environmentId: "one" } as const;
const environments: EnvironmentRef[] = [LOCAL_ENVIRONMENT, remote];
const input = {
	addedProjects: [],
	activeCwd: "/new",
	pinnedSessions: [],
	pinnedProjects: [],
	expandedGroups: [],
	expandedGroupsTouched: false,
};
const meta = { sessionId: "new", cwd: "/new", createdAt: 1, name: "new" } as never;
let result: ReturnType<typeof usePagedSidebar>;
function Harness({ pins = input.pinnedSessions }: { pins?: string[] }) {
	result = usePagedSidebar({ ...input, pinnedSessions: pins });
	return null;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
afterEach(() => {
	useSessionCatalogStore.getState().clear();
	useProjectsStore.setState({ allSessions: [], search: "" });
	useSessionsStore.setState({ sessions: [] });
	useRemoteConnectionStore.setState({ status: { revision: 0, state: "disconnected" } });
	vi.unstubAllGlobals();
});

it("verifies more than 100 pinned sessions in bounded batches", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	api.querySessionProjects.mockResolvedValue({ projects: [], complete: true, revision: "pins", errors: 0 });
	api.verifySessionCatalog.mockImplementation(async ({ references }) => {
		if (references.length > 100) throw new Error("too many references");
		return references.map((reference: { sessionId: string }) => ({
			reference,
			status: "present",
			meta: { cwd: "/new", createdAt: 1, sessionId: reference.sessionId },
		}));
	});
	const pins = Array.from({ length: 205 }, (_, i) => `pin-${i}`);
	const root = createRoot(document.createElement("div"));
	await act(async () => root.render(<Harness pins={pins} />));
	expect(result.verified).toHaveLength(205);
	expect(api.verifySessionCatalog.mock.calls.map(([arg]) => arg.references.length)).toEqual(
		expect.arrayContaining([100, 5]),
	);
	expect(api.verifySessionCatalog.mock.calls.every(([arg]) => arg.references.length <= 100)).toBe(true);
	await act(() => root.unmount());
});

it("keeps a memory-created project after write-through and GC until indexed", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	api.querySessionProjects.mockResolvedValue({ projects: [], complete: true, revision: "1", errors: 0 });
	useSessionsStore.setState({ sessions: [meta] });
	const root = createRoot(document.createElement("div"));
	await act(async () => {
		root.render(<Harness />);
	});
	expect(result.data.projects.map((p) => p.cwd)).toContain("/new");
	await act(() => {
		useSessionsStore.setState({ sessions: [] });
	});
	expect(result.data.projects.map((p) => p.cwd)).toContain("/new");
	await act(() => {
		useProjectsStore.setState({ allSessions: [] });
	});
	expect(result.data.projects.map((p) => p.cwd)).not.toContain("/new");
	await act(() => root.unmount());
});

it("restores a cached empty remote search when the connection drops", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const cwd = environmentEntityKey(remote, "/remote-project");
	api.querySessionProjects.mockResolvedValue({ projects: [], complete: true, revision: "1", errors: 0 });
	api.querySessionCatalog.mockResolvedValue({ sessions: [], complete: true, revision: "1", errors: 0 });
	useProjectsStore.setState({ search: "missing" });
	useRemoteConnectionStore.setState({ status: { revision: 1, state: "connected", environment: remote } });
	const root = createRoot(document.createElement("div"));
	await act(async () => root.render(<Harness />));
	await act(async () => {
		await useSessionCatalogStore
			.getState()
			.loadPage(remote, { cwd, search: "missing", archived: false, limit: 6 });
		const key = environmentKey(remote);
		const catalog = useSessionCatalogStore.getState().byEnvironment[key];
		if (!catalog) throw new Error("missing remote catalog");
		useSessionCatalogStore.setState((state) => ({
			byEnvironment: {
				...state.byEnvironment,
				[key]: {
					...catalog,
					projects: {
						projects: [{ cwd, sessionCount: 1, archivedCount: 0, lastActive: 1 }],
						complete: true,
						revision: "1",
						errors: 0,
					},
				},
			},
		}));
	});
	expect(result.data.projects.map((project) => project.cwd)).not.toContain(cwd);
	await act(async () =>
		useRemoteConnectionStore.setState({
			status: { revision: 2, state: "disconnected", environment: remote },
		}),
	);
	expect(result.data.projects.map((project) => project.cwd)).toContain(cwd);
	await act(() => root.unmount());
});

it("keeps an empty search project visible during a scan or project diagnostics", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	api.querySessionProjects.mockResolvedValue({
		projects: [{ cwd: "/p", sessionCount: 4, lastActive: 1 }],
		complete: true,
		revision: "1",
		errors: 0,
		scan: null,
	});
	api.querySessionCatalog.mockResolvedValue({
		sessions: [],
		complete: true,
		revision: "1",
		errors: 0,
		scan: null,
		diagnostics: { errors: 0, reasons: {} },
	});
	useProjectsStore.setState({ search: "missing" });
	const root = createRoot(document.createElement("div"));
	await act(async () => root.render(<Harness />));
	await act(async () => {
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, {
			cwd: "/p",
			search: "missing",
			archived: false,
			limit: 6,
		});
	});
	expect(result.data.projects).toHaveLength(0);
	const key = environmentKey(LOCAL_ENVIRONMENT);
	const update = (scan: { id: string; startedAt: number } | null, errors: number) => {
		const state = useSessionCatalogStore.getState().byEnvironment[key];
		if (!state) throw new Error("missing catalog");
		const entry = Object.entries(state.pages)[0];
		if (!entry) throw new Error("missing page");
		const [pageKey, page] = entry;
		useSessionCatalogStore.setState({
			byEnvironment: {
				[key]: {
					...state,
					projects: state.projects && { ...state.projects, scan },
					pages: { ...state.pages, [pageKey]: { ...page, diagnostics: { errors, reasons: {} } } },
				},
			},
		});
	};
	await act(() => update({ id: "scan", startedAt: 1 }, 0));
	expect(result.data.projects).toHaveLength(1);
	await act(() => update(null, 1));
	expect(result.data.projects).toHaveLength(1);
	await act(() => update(null, 0));
	expect(result.data.projects).toHaveLength(0);
	await act(() => root.unmount());
});

it("waits for the matching search page before hiding an empty project", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	api.querySessionProjects.mockResolvedValue({
		projects: [{ cwd: "/p", sessionCount: 4, lastActive: 1 }],
		complete: true,
		revision: "1",
		errors: 0,
	});
	const page = deferred<{ sessions: never[]; complete: boolean; revision: string; errors: number }>();
	api.querySessionCatalog.mockReturnValue(page.promise);
	useProjectsStore.setState({ search: "missing" });
	const root = createRoot(document.createElement("div"));
	await act(async () => {
		root.render(<Harness />);
	});
	expect(result.data.projects).toHaveLength(1);
	await act(() => {
		void useSessionCatalogStore
			.getState()
			.loadPage(LOCAL_ENVIRONMENT, { cwd: "/p", search: "missing", archived: false, limit: 6 });
	});
	expect(result.data.projects).toHaveLength(1);
	await act(async () => {
		page.resolve({ sessions: [], complete: true, revision: "1", errors: 0 });
	});
	expect(result.data.projects).toHaveLength(0);
	await act(() => root.unmount());
});
