import { environmentKey, LOCAL_ENVIRONMENT, type SessionCatalogPage, type SessionMeta } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	querySessionProjects: vi.fn(),
	querySessionCatalog: vi.fn(),
	onSessionCatalogChanged: vi.fn(),
}));
vi.mock("../environment-api", () => ({ getExecutionApi: () => api }));

import { sessionCatalogPageKey, useSessionCatalogStore } from "./session-catalog";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const meta = (id: string): SessionMeta => ({
	sessionId: id,
	cwd: "/a",
	name: id,
	createdAt: 0,
	modifiedAt: 0,
	sessionFile: id,
	active: false,
	messageCount: 0,
});
const page = (id: string, revision = "1", nextCursor?: string): SessionCatalogPage => ({
	sessions: [meta(id)],
	revision,
	nextCursor,
	complete: true,
	errors: 0,
});
const query = { cwd: "/a" };
const state = () => useSessionCatalogStore.getState().byEnvironment[environmentKey(LOCAL_ENVIRONMENT)];
const current = () => state()?.pages[sessionCatalogPageKey(query)];

beforeEach(() => {
	useSessionCatalogStore.getState().clear();
	vi.resetAllMocks();
	api.querySessionProjects.mockResolvedValue({ projects: [], revision: "1", complete: true, errors: 0 });
	api.onSessionCatalogChanged.mockReturnValue(() => {});
});

describe("session catalog", () => {
	it("loads six then appends sixteen, resetting on revision mismatch", async () => {
		api.querySessionCatalog
			.mockResolvedValueOnce(page("a", "1", "next"))
			.mockResolvedValueOnce(page("b", "1", "next2"))
			.mockResolvedValueOnce(page("bad", "2"))
			.mockResolvedValueOnce(page("fresh", "2"));
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query, true);
		expect(current()?.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
		expect(api.querySessionCatalog.mock.calls[0]?.[0]).toEqual({ query: { ...query, limit: 6 } });
		expect(api.querySessionCatalog.mock.calls[1]?.[0]).toEqual({
			query: { ...query, limit: 16, cursor: "next" },
		});
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query, true);
		expect(current()?.sessions.map((s) => s.sessionId)).toEqual(["fresh"]);
		expect(api.querySessionCatalog.mock.calls[3]?.[0]).toEqual({ query: { ...query, limit: 6 } });
	});
	it("rejects older results and errors, retaining trusted content on failure and clear", async () => {
		api.querySessionCatalog.mockResolvedValueOnce(page("old"));
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		const first = deferred<SessionCatalogPage>();
		const second = deferred<SessionCatalogPage>();
		api.querySessionCatalog.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const a = useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		const b = useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		second.resolve(page("new"));
		await b;
		first.reject(new Error("late"));
		await a;
		expect(current()?.sessions[0]?.sessionId).toBe("new");
		expect(current()?.error).toBeUndefined();
		api.querySessionCatalog.mockRejectedValueOnce(new Error("offline"));
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		expect(current()?.sessions[0]?.sessionId).toBe("new");
		expect(current()?.error).toBe("offline");
		const pending = deferred<SessionCatalogPage>();
		api.querySessionCatalog.mockReturnValueOnce(pending.promise);
		const c = useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		useSessionCatalogStore.getState().clear();
		pending.resolve(page("late"));
		await c;
		expect(state()).toBeUndefined();
	});
	it("subscribes before baseline, shares and disposes, coalesces repeated changes", async () => {
		vi.useFakeTimers();
		let change!: (event: { revision: string; complete: boolean }) => void;
		const off = vi.fn();
		api.onSessionCatalogChanged.mockImplementation((cb) => {
			change = cb;
			return off;
		});
		api.querySessionCatalog.mockResolvedValue(page("x"));
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		const a = useSessionCatalogStore.getState().watch(LOCAL_ENVIRONMENT);
		const b = useSessionCatalogStore.getState().watch(LOCAL_ENVIRONMENT);
		expect(api.onSessionCatalogChanged).toHaveBeenCalledTimes(1);
		expect(api.onSessionCatalogChanged.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
			api.querySessionProjects.mock.invocationCallOrder[0] ?? 0,
		);
		change({ revision: "2", complete: false });
		change({ revision: "2", complete: false });
		await vi.advanceTimersByTimeAsync(150);
		expect(api.querySessionCatalog).toHaveBeenCalledTimes(2);
		a();
		expect(off).not.toHaveBeenCalled();
		b();
		b();
		expect(off).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
	it("isolates environments and preserves projects after failed refresh", async () => {
		const remote = { kind: "ssh", connectionId: "remote", environmentId: "remote" } as const;
		const localResult = deferred<SessionCatalogPage>();
		api.querySessionCatalog.mockReturnValueOnce(localResult.promise).mockResolvedValueOnce(page("remote"));
		const local = useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		await useSessionCatalogStore.getState().loadPage(remote, query);
		useSessionCatalogStore.getState().clear(LOCAL_ENVIRONMENT);
		localResult.resolve(page("late"));
		await local;
		expect(state()).toBeUndefined();
		expect(
			useSessionCatalogStore.getState().byEnvironment[environmentKey(remote)]?.pages[
				sessionCatalogPageKey(query)
			]?.sessions[0]?.sessionId,
		).toBe("remote");
		await useSessionCatalogStore.getState().loadProjects(remote);
		api.querySessionProjects.mockRejectedValueOnce(new Error("offline"));
		await useSessionCatalogStore.getState().loadProjects(remote);
		expect(useSessionCatalogStore.getState().byEnvironment[environmentKey(remote)]?.projects?.revision).toBe(
			"1",
		);
		expect(useSessionCatalogStore.getState().byEnvironment[environmentKey(remote)]?.error).toBe("offline");
	});
	it("restarts an explicitly stale cursor", async () => {
		api.querySessionCatalog
			.mockResolvedValueOnce(page("old", "1", "cursor"))
			.mockRejectedValueOnce(new Error("stale cursor"))
			.mockResolvedValueOnce(page("fresh", "2"));
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query, true);
		expect(current()?.sessions.map((s) => s.sessionId)).toEqual(["fresh"]);
	});
	it("refreshes the loaded range and evicts obsolete searches", async () => {
		api.querySessionCatalog.mockImplementation(async ({ query: q }) => {
			const start = q.cursor ? Number(q.cursor) : 0;
			const end = Math.min(start + q.limit, 40);
			return {
				sessions: Array.from({ length: end - start }, (_, i) => meta(String(start + i))),
				revision: "1",
				complete: true,
				errors: 0,
				nextCursor: end < 40 ? String(end) : undefined,
			};
		});
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query, true);
		expect(current()?.sessions).toHaveLength(22);
		useSessionCatalogStore.getState().invalidate(LOCAL_ENVIRONMENT);
		await vi.waitFor(() => expect(current()?.loading).toBe(false));
		expect(current()?.sessions).toHaveLength(22);
		for (let i = 0; i < 25; i++)
			await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, { ...query, search: String(i) });
		expect(Object.keys(state()?.pages ?? {})).toHaveLength(2);
		await useSessionCatalogStore
			.getState()
			.loadPage(LOCAL_ENVIRONMENT, { ...query, archived: false, search: "obsolete" });
		useSessionCatalogStore.getState().retainSidebarSearch("");
		expect(
			state()?.pages[sessionCatalogPageKey({ ...query, archived: false, search: "obsolete" })],
		).toBeUndefined();
	});
	it("reports missing methods instead of remaining loading", async () => {
		const saved = api.querySessionCatalog;
		Object.assign(api, { querySessionCatalog: undefined });
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		expect(current()?.loading).toBe(false);
		expect(current()?.error).toContain("querySessionCatalog");
		Object.assign(api, { querySessionCatalog: saved });
	});
});
