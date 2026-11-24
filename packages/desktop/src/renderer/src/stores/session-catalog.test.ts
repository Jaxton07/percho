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
	it("keeps discovery failure visible while retrying and clears it only on success", async () => {
		api.querySessionProjects.mockRejectedValueOnce(new Error("unavailable"));
		await useSessionCatalogStore.getState().loadProjects(LOCAL_ENVIRONMENT);
		const retry = deferred<import("@percho/shared").SessionCatalogProjects>();
		api.querySessionProjects.mockReturnValueOnce(retry.promise);
		const request = useSessionCatalogStore.getState().loadProjects(LOCAL_ENVIRONMENT);
		expect(state()?.loading).toBe(true);
		expect(state()?.error).toBe("unavailable");
		retry.resolve({ projects: [], revision: "fresh", complete: true, errors: 0 });
		await request;
		expect(state()?.error).toBeUndefined();
	});
	it("revalidates cached remote pages on a new watch even without a directory change event", async () => {
		const remote = { kind: "ssh", connectionId: "host", environmentId: "remote" } as const;
		api.querySessionCatalog.mockResolvedValueOnce({ ...page("old"), sessions: [] });
		await useSessionCatalogStore.getState().loadPage(remote, query);
		api.querySessionCatalog.mockClear();
		api.querySessionCatalog.mockResolvedValue(page("new"));
		const stop = useSessionCatalogStore.getState().watch(remote);
		expect(api.querySessionCatalog).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		const remotePage =
			useSessionCatalogStore.getState().byEnvironment[environmentKey(remote)]?.pages[
				sessionCatalogPageKey(query)
			];
		expect(remotePage?.sessions[0]?.sessionId).toBe("new");
		stop();
	});
	it.each([-3600000, 3600000])(
		"uses elapsed scan time despite a remote clock offset of %i ms",
		async (offset) => {
			vi.useFakeTimers();
			vi.setSystemTime(10000);
			const scan = { id: "remote-scan", startedAt: 10000 + offset, elapsedMs: 1500 };
			api.querySessionCatalog.mockResolvedValue({ ...page("a"), scan });
			await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
			expect(current()?.scan?.startedAt).toBe(8500);
			vi.setSystemTime(11000);
			await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
			expect(current()?.scan?.startedAt).toBe(8500);
			vi.useRealTimers();
		},
	);
	it("refetches scoped diagnostics when their version changes without invalidating data cursors", async () => {
		vi.useFakeTimers();
		let change: (event: import("@percho/shared").SessionCatalogChange) => void = () => {};
		api.onSessionCatalogChanged.mockImplementation((handler) => {
			change = handler;
			return () => {};
		});
		api.querySessionProjects.mockResolvedValue({
			projects: [],
			revision: "1",
			complete: false,
			errors: 1,
			diagnostics: { errors: 1, reasons: {}, revision: "old" },
		});
		api.querySessionCatalog.mockResolvedValue({
			...page("a", "1", "cursor"),
			sessions: Array.from({ length: 6 }, (_, index) => meta(`a${index}`)),
			complete: false,
			diagnostics: { errors: 0, reasons: {}, revision: "old" },
		});
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		const stop = useSessionCatalogStore.getState().watch(LOCAL_ENVIRONMENT);
		await Promise.resolve();
		const count = api.querySessionCatalog.mock.calls.length;
		change({
			revision: "1",
			complete: false,
			scan: null,
			diagnostics: { errors: 1, reasons: {}, revision: "new" },
		});
		await vi.advanceTimersByTimeAsync(150);
		expect(api.querySessionCatalog).toHaveBeenCalledTimes(count + 1);
		expect(current()?.revision).toBe("1");
		expect(current()?.nextCursor).toBe("cursor");
		stop();
		vi.useRealTimers();
	});
	it("passes refresh only to the first request and preserves the loaded range", async () => {
		api.querySessionCatalog.mockImplementation(async ({ query: q }) => {
			const start = Number(q.cursor ?? 0);
			return {
				...page(String(start), "1", start < 10 ? String(start + q.limit) : undefined),
				sessions: Array.from({ length: q.limit }, (_, i) => meta(String(start + i))),
			};
		});
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query, true);
		api.querySessionCatalog.mockClear();
		await useSessionCatalogStore
			.getState()
			.loadPage(LOCAL_ENVIRONMENT, { ...query, refresh: true }, false, true);
		expect(api.querySessionCatalog.mock.calls[0]?.[0].query.refresh).toBe(true);
		expect(api.querySessionCatalog.mock.calls[1]?.[0].query.refresh).toBeUndefined();
		expect(current()?.query.refresh).toBeUndefined();
		expect(current()?.sessions).toHaveLength(22);
	});
	it("keeps the original loading time across overlapping requests and clears it on failure", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		const first = deferred<SessionCatalogPage>();
		const second = deferred<SessionCatalogPage>();
		api.querySessionCatalog.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const a = useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		vi.setSystemTime(2000);
		const b = useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		expect(current()?.loadingStartedAt).toBe(1000);
		second.reject(new Error("failed"));
		await b;
		expect(current()?.loadingStartedAt).toBeUndefined();
		first.resolve(page("late"));
		await a;
		vi.useRealTimers();
	});
	it("propagates scan-only changes without refetch or replacing scoped diagnostics, rejecting late snapshots", async () => {
		vi.useFakeTimers();
		let change!: (event: import("@percho/shared").SessionCatalogChange) => void;
		api.onSessionCatalogChanged.mockImplementation((cb) => {
			change = cb;
			return () => {};
		});
		const scoped = { errors: 1, reasons: { scoped: 1 } };
		api.querySessionCatalog.mockResolvedValue({ ...page("a"), scan: null, diagnostics: scoped });
		await useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		const stop = useSessionCatalogStore.getState().watch(LOCAL_ENVIRONMENT);
		await Promise.resolve();
		change({ revision: "1", complete: true, scan: null });
		await vi.advanceTimersByTimeAsync(150);
		const pending = deferred<SessionCatalogPage>();
		api.querySessionCatalog.mockReturnValueOnce(pending.promise);
		const load = useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		const count = api.querySessionCatalog.mock.calls.length;
		const scan = { id: "scan", startedAt: 100 };
		change({ revision: "1", complete: true, scan, diagnostics: { errors: 4, reasons: { global: 4 } } });
		expect(current()?.scan).toEqual(scan);
		expect(current()?.diagnostics).toEqual(scoped);
		pending.resolve({ ...page("late"), scan: null, diagnostics: scoped });
		await load;
		expect(current()?.scan).toEqual(scan);
		change({ revision: "1", complete: true, scan: null });
		expect(current()?.scan).toBeNull();
		await vi.advanceTimersByTimeAsync(150);
		expect(api.querySessionCatalog).toHaveBeenCalledTimes(count);
		stop();
		vi.useRealTimers();
	});
	it("protects pending project and page snapshots started before watching", async () => {
		let change!: (event: import("@percho/shared").SessionCatalogChange) => void;
		api.onSessionCatalogChanged.mockImplementation((cb) => {
			change = cb;
			return () => {};
		});
		const projects = deferred<import("@percho/shared").SessionCatalogProjects>();
		const result = deferred<SessionCatalogPage>();
		api.querySessionProjects.mockReturnValue(projects.promise);
		api.querySessionCatalog.mockReturnValue(result.promise);
		const pageLoad = useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		const stop = useSessionCatalogStore.getState().watch(LOCAL_ENVIRONMENT);
		const scan = { id: "new", startedAt: 42 };
		change({ revision: "1", complete: true, scan });
		projects.resolve({ projects: [], revision: "1", complete: true, errors: 0, scan: null });
		result.resolve({ ...page("a"), scan: null });
		await pageLoad;
		await Promise.resolve();
		expect(current()?.scan).toEqual(scan);
		expect(state()?.projects?.scan).toEqual(scan);
		stop();
		change({ revision: "2", complete: true, scan: null });
		expect(current()?.scan).toEqual(scan);
	});
	it("does not revive a released watch or commit its pending request", async () => {
		let change!: (event: import("@percho/shared").SessionCatalogChange) => void;
		api.onSessionCatalogChanged.mockImplementation((cb) => {
			change = cb;
			return () => {};
		});
		const pending = deferred<SessionCatalogPage>();
		api.querySessionCatalog.mockReturnValueOnce(pending.promise);
		const stop = useSessionCatalogStore.getState().watch(LOCAL_ENVIRONMENT);
		const load = useSessionCatalogStore.getState().loadPage(LOCAL_ENVIRONMENT, query);
		stop();
		change({ revision: "1", complete: true, scan: { id: "late", startedAt: 1 } });
		pending.resolve({ ...page("late"), scan: { id: "late", startedAt: 1 } });
		await load;
		expect(current()?.sessions).toEqual([]);
		expect(current()?.loading).toBe(false);
		expect(current()?.scan).toBeUndefined();
	});
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
