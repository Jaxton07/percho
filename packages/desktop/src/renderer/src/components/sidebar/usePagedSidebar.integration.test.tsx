// @vitest-environment happy-dom

import { LOCAL_ENVIRONMENT } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectsStore } from "../../stores/projects";
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
const environments = [LOCAL_ENVIRONMENT];
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
