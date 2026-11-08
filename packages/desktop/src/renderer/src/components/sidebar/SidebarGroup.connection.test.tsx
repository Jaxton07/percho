// @vitest-environment happy-dom
import {
	environmentEntityKey,
	environmentKey,
	type RemoteConnectionStatus,
	type SessionMeta,
} from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidebarGroup as Group } from "../../lib/sidebar-groups";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { sessionCatalogPageKey, useSessionCatalogStore } from "../../stores/session-catalog";
import { useSessionsStore } from "../../stores/sessions";
import { SidebarGroup } from "./SidebarGroup";
import type { SidebarBatching } from "./useSidebarBatching";

const api = vi.hoisted(() => ({ querySessionCatalog: vi.fn(), remoteConnect: vi.fn() }));
vi.mock("../../environment-api", () => ({ getExecutionApi: () => api }));
vi.mock("../../api", () => ({ getPi: () => api }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("./ProjectRow", () => ({ ProjectRow: () => null }));
vi.mock("./SessionMenu", () => ({ useSessionMenu: () => ({ open: vi.fn(), element: null }) }));

const environment = { kind: "ssh", connectionId: "host", environmentId: "one" } as const;
const other = { kind: "ssh", connectionId: "host", environmentId: "two" } as const;
const cwd = environmentEntityKey(environment, "/project");
const query = { cwd, archived: false, limit: 6 };
const group: Group = {
	key: cwd,
	cwd,
	kind: "project",
	label: "project",
	sessionCount: 0,
	sessions: [],
	expanded: true,
};
const batching: SidebarBatching = {
	searching: false,
	isExpanded: () => true,
	moreClicks: () => 0,
	showMore: vi.fn(),
	toggleGroup: vi.fn(),
	forget: vi.fn(),
};
const session = (name: string): SessionMeta => ({
	sessionId: environmentEntityKey(environment, name),
	cwd,
	name,
	sessionFile: `/project/${name}.jsonl`,
	createdAt: 1,
	messageCount: 1,
	active: false,
});
const result = (name: string, nextCursor?: string) => ({
	sessions: [session(name)],
	revision: "1",
	complete: false,
	errors: 0,
	nextCursor,
});
let container: HTMLDivElement;
let root: Root;

function status(
	state: "connected" | "disconnected",
	env: NonNullable<RemoteConnectionStatus["environment"]> = environment,
) {
	useRemoteConnectionStore.setState({ status: { revision: 1, state, environment: env } });
}
async function render(expanded = true) {
	await act(async () =>
		root.render(
			<SidebarGroup
				group={group}
				activeSessionId={null}
				batching={{ ...batching, isExpanded: () => expanded }}
				paging={{ search: "", verified: [], pinnedSessions: [], known: [] }}
			/>,
		),
	);
}
async function cache(name: string, nextCursor?: string, error = false) {
	api.querySessionCatalog.mockResolvedValueOnce(result(name, nextCursor));
	await useSessionCatalogStore.getState().loadPage(environment, query);
	if (error) {
		api.querySessionCatalog.mockRejectedValueOnce(new Error("offline"));
		await useSessionCatalogStore.getState().loadPage(environment, query);
	}
	api.querySessionCatalog.mockClear();
}
function button(label: string) {
	return [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(label));
}
function expectOnlyOffline() {
	expect(container.textContent).toContain("sidebar.catalogOffline");
	expect(container.textContent).not.toContain("sidebar.catalogPartial");
	expect(container.textContent).not.toContain("sidebar.catalogRetry");
	expect(container.textContent).not.toContain("sidebar.catalogLoading");
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
	vi.resetAllMocks();
	useSessionCatalogStore.getState().clear();
	useSessionsStore.setState({ sessions: [] });
	useRemoteConnectionStore.setState({ open: false });
	status("disconnected");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	useSessionCatalogStore.getState().clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("offline initially does not query or show partial, retry or loading", async () => {
	await render();
	expect(api.querySessionCatalog).not.toHaveBeenCalled();
	expectOnlyOffline();
});

it("retains cached rows and cursor, disables more and opens the connection panel without connecting", async () => {
	await cache("cached", "next", true);
	await render();
	expectOnlyOffline();
	expect(container.textContent).toContain("cached");
	expect(
		useSessionCatalogStore.getState().byEnvironment[environmentKey(environment)]?.pages[
			sessionCatalogPageKey(query)
		]?.nextCursor,
	).toBe("next");
	expect(container.querySelector<HTMLButtonElement>("[data-sidebar-show-more]")?.disabled).toBe(true);
	const connect = button("sidebar.catalogConnect");
	expect(connect).toBeDefined();
	await act(() => connect?.click());
	expect(useRemoteConnectionStore.getState().open).toBe(true);
	expect(api.remoteConnect).not.toHaveBeenCalled();
	expect(api.querySessionCatalog).not.toHaveBeenCalled();
});

it("refreshes a cached error page when the same environment reconnects", async () => {
	await cache("old", undefined, true);
	await render();
	expectOnlyOffline();
	api.querySessionCatalog.mockResolvedValueOnce({ ...result("fresh"), complete: true });
	await act(async () => status("connected"));
	expect(api.querySessionCatalog).toHaveBeenCalledTimes(1);
	expect(api.querySessionCatalog).toHaveBeenCalledWith({ query });
	expect(container.textContent).toContain("fresh");
	expect(container.textContent).not.toContain("old");
	expect(container.textContent).not.toContain("sidebar.catalogRetry");
});

it("preserves loaded pages when reconnecting and reopening an expanded group", async () => {
	vi.spyOn(batching, "moreClicks").mockReturnValue(1);
	const rows = Array.from({ length: 22 }, (_, index) => session(`cached-${index}`));
	const head = { ...result("unused", "next"), sessions: rows.slice(0, 6) };
	const tail = { ...result("unused", "more"), sessions: rows.slice(6) };
	api.querySessionCatalog.mockResolvedValueOnce(head).mockResolvedValueOnce(tail);
	await useSessionCatalogStore.getState().loadPage(environment, query);
	await useSessionCatalogStore.getState().loadPage(environment, query, true);
	api.querySessionCatalog.mockClear();
	await render();
	api.querySessionCatalog.mockResolvedValueOnce(head).mockResolvedValueOnce(tail);
	await act(async () => status("connected"));
	expect(container.querySelectorAll("[data-session-id]")).toHaveLength(22);
	expect(api.querySessionCatalog).toHaveBeenCalledTimes(2);
	await render(false);
	api.querySessionCatalog.mockClear();
	api.querySessionCatalog.mockResolvedValueOnce(head).mockResolvedValueOnce(tail);
	await render(true);
	expect(container.querySelectorAll("[data-session-id]")).toHaveLength(22);
	expect(api.querySessionCatalog).toHaveBeenCalledTimes(2);
});

it("treats a connection to a different environment as offline", async () => {
	status("connected", other);
	await render();
	expect(api.querySessionCatalog).not.toHaveBeenCalled();
	expectOnlyOffline();
});

it("shows only retry for an online error, not partial", async () => {
	await cache("cached", undefined, true);
	status("connected");
	await render();
	expect(container.textContent).toContain("sidebar.catalogRetry");
	expect(container.textContent).not.toContain("sidebar.catalogPartial");
	expect(container.textContent).not.toContain("sidebar.catalogOffline");
	expect(container.textContent).not.toContain("sidebar.catalogLoading");
});
