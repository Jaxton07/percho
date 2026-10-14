import { readFileSync } from "node:fs";
import type { PermissionMode, SessionMeta } from "@percho/shared";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pi = vi.hoisted(() => ({
	openSession: vi.fn(),
	getSessionMessages: vi.fn(),
	getFollowUpMessages: vi.fn(),
	getTodos: vi.fn(),
	getPermissionMode: vi.fn(),
	setPermissionMode: vi.fn(),
	markSessionHistoryReady: vi.fn(),
}));
vi.mock("../api", () => ({ getPi: () => pi }));

import { clearSessionHistory, isHistoryReady } from "./session-history";
import { createSessionLoader } from "./session-loading";
import {
	currentNavigationToken,
	currentUserIntentToken,
	isLatestNavigation,
	isLatestUserIntent,
	noteUserIntent,
} from "./session-navigation";
import { useToastsStore } from "./toasts";
import { useTranscriptStore } from "./transcript";
import { useUiPreferencesStore } from "./ui-preferences";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
const ids = new Set<string>();
const meta = (id: string, name?: string): SessionMeta => {
	ids.add(id);
	return {
		sessionId: id,
		sessionFile: `/${id}.jsonl`,
		cwd: "/fixture",
		active: true,
		messageCount: 0,
		createdAt: 1,
		name,
	};
};
function fixture(id: string) {
	const sessions = new Map([[id, meta(id)]]),
		modes = new Map<string, PermissionMode>();
	const landMeta = vi.fn((value: SessionMeta) => {
		sessions.set(value.sessionId, value);
	});
	const writePermissionMode = vi.fn((key: string, mode: PermissionMode) => {
		modes.set(key, mode);
	});
	const loader = createSessionLoader({
		isOpen: (key) => sessions.has(key),
		landMeta,
		readPermissionMode: (key) => modes.get(key),
		writePermissionMode,
	});
	return { loader, sessions, modes, landMeta, writePermissionMode };
}
beforeEach(() => {
	vi.resetAllMocks();
	pi.getSessionMessages.mockResolvedValue([]);
	pi.getFollowUpMessages.mockResolvedValue([]);
	pi.getTodos.mockResolvedValue([]);
	pi.getPermissionMode.mockResolvedValue("default");
	pi.setPermissionMode.mockResolvedValue(undefined);
	pi.markSessionHistoryReady.mockResolvedValue(undefined);
	useTranscriptStore.setState({ bySession: {} });
	useUiPreferencesStore.setState({ sessionPermissionModes: {} });
	useToastsStore.setState({ toasts: [] });
});
afterEach(() => {
	for (const id of ids) clearSessionHistory(id);
	ids.clear();
});

describe("session loader owns flights and data, not navigation", () => {
	it("forget invalidates old file landing; old finally cannot remove a new flight", async () => {
		const f = fixture("file"),
			old = deferred<SessionMeta>(),
			next = deferred<SessionMeta>();
		pi.openSession.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
		const first = f.loader.ensureOpenSession(" /file.jsonl ", { loadBundle: false });
		f.loader.forget("file", "/file.jsonl");
		f.sessions.delete("file");
		const second = f.loader.ensureOpenSession("/file.jsonl", { loadBundle: false });
		try {
			old.resolve(meta("file", "old"));
			expect(await first).toBeNull();
			expect(f.landMeta).not.toHaveBeenCalled();
			expect(f.loader.ensureOpenSession(" /file.jsonl ")).toBe(second);
			expect(pi.openSession).toHaveBeenCalledTimes(2);
			next.resolve(meta("file", "new"));
			expect((await second)?.name).toBe("new");
			expect(f.landMeta).toHaveBeenCalledOnce();
		} finally {
			old.resolve(meta("file"));
			next.resolve(meta("file"));
			await Promise.allSettled([first, second]);
		}
	});
	it("forgotten old open rejection stays silent and leaves the replacement flight/meta intact", async () => {
		const f = fixture("open-reject"),
			old = deferred<SessionMeta>(),
			next = deferred<SessionMeta>();
		pi.openSession.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
		const first = f.loader.ensureOpenSession("/open-reject.jsonl");
		f.loader.forget("open-reject", "/open-reject.jsonl");
		f.sessions.delete("open-reject");
		const second = f.loader.ensureOpenSession("/open-reject.jsonl");
		try {
			old.reject(Error("obsolete open"));
			expect(await first).toBeNull();
			expect(useToastsStore.getState().toasts).toEqual([]);
			expect(f.landMeta).not.toHaveBeenCalled();
			expect(f.loader.ensureOpenSession("/open-reject.jsonl")).toBe(second);
			expect(pi.openSession).toHaveBeenCalledTimes(2);
			next.resolve(meta("open-reject", "new"));
			expect((await second)?.name).toBe("new");
			expect(f.sessions.get("open-reject")?.name).toBe("new");
		} finally {
			old.resolve(meta("open-reject"));
			next.resolve(meta("open-reject"));
			await Promise.allSettled([first, second]);
		}
	});
	it("forgotten old bundle rejection stays silent and leaves the replacement file flight intact", async () => {
		const f = fixture("bundle-reject"),
			oldHistory = deferred<never[]>(),
			next = deferred<SessionMeta>();
		pi.openSession.mockResolvedValueOnce(meta("bundle-reject", "old")).mockReturnValueOnce(next.promise);
		pi.getSessionMessages.mockReturnValueOnce(oldHistory.promise);
		const first = f.loader.ensureOpenSession("/bundle-reject.jsonl");
		let second: Promise<SessionMeta | null> | undefined;
		try {
			await vi.waitFor(() => expect(pi.getSessionMessages).toHaveBeenCalledOnce());
			f.loader.forget("bundle-reject", "/bundle-reject.jsonl");
			f.sessions.delete("bundle-reject");
			second = f.loader.ensureOpenSession("/bundle-reject.jsonl");
			oldHistory.reject(Error("obsolete bundle"));
			expect(await first).toBeNull();
			expect(useToastsStore.getState().toasts).toEqual([]);
			expect(f.sessions.has("bundle-reject")).toBe(false);
			expect(f.loader.ensureOpenSession("/bundle-reject.jsonl")).toBe(second);
			expect(pi.openSession).toHaveBeenCalledTimes(2);
			next.resolve(meta("bundle-reject", "new"));
			expect((await second)?.name).toBe("new");
			expect(f.sessions.get("bundle-reject")?.name).toBe("new");
		} finally {
			oldHistory.resolve([]);
			next.resolve(meta("bundle-reject"));
			await Promise.allSettled([first, ...(second ? [second] : [])]);
		}
	});
	it("valid bundle failure returns opened meta and exactly one toast", async () => {
		const f = fixture("valid-bundle-reject");
		pi.openSession.mockResolvedValue(meta("valid-bundle-reject"));
		pi.getTodos.mockRejectedValueOnce(Error("valid bundle"));
		expect(await f.loader.ensureOpenSession("/valid-bundle-reject.jsonl")).toMatchObject({
			sessionId: "valid-bundle-reject",
		});
		expect(useToastsStore.getState().toasts).toHaveLength(1);
	});
	it("loadBundle:false also checks identity after synchronous landMeta invalidation", async () => {
		const f = fixture("land-forget");
		pi.openSession.mockResolvedValue(meta("land-forget"));
		f.landMeta.mockImplementationOnce(() => {
			f.loader.forget("land-forget", "/land-forget.jsonl");
		});
		expect(await f.loader.ensureOpenSession("/land-forget.jsonl", { loadBundle: false })).toBeNull();
		expect(pi.getSessionMessages).not.toHaveBeenCalled();
		expect(useToastsStore.getState().toasts).toEqual([]);
	});
	it("forget/reopen keeps new bundle flight through old finally; epoch blocks old history/permission/ACK", async () => {
		const f = fixture("bundle"),
			old = deferred<never[]>(),
			next = deferred<never[]>();
		pi.getSessionMessages.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
		const first = f.loader.loadSessionBundle("bundle");
		f.loader.forget("bundle", "/bundle.jsonl");
		f.sessions.set("bundle", meta("bundle", "new"));
		const second = f.loader.loadSessionBundle("bundle");
		try {
			old.resolve([]);
			await first;
			expect(isHistoryReady("bundle")).toBe(false);
			expect(pi.markSessionHistoryReady).not.toHaveBeenCalled();
			expect(f.writePermissionMode).not.toHaveBeenCalled();
			expect(f.loader.loadSessionBundle("bundle")).toBe(second);
			expect(pi.getSessionMessages).toHaveBeenCalledTimes(2);
			next.resolve([]);
			await second;
			expect(isHistoryReady("bundle")).toBe(true);
			expect(pi.markSessionHistoryReady).toHaveBeenCalledOnce();
		} finally {
			old.resolve([]);
			next.resolve([]);
			await Promise.allSettled([first, second]);
		}
	});
	it("failed file flight reports one toast, clears for retry and reads ports on landing", async () => {
		const f = fixture("retry");
		pi.openSession.mockRejectedValueOnce(Error("open failure")).mockResolvedValue(meta("retry"));
		const first = f.loader.ensureOpenSession("/retry.jsonl"),
			second = f.loader.ensureOpenSession(" /retry.jsonl ");
		expect(first).toBe(second);
		expect(await first).toBeNull();
		expect(useToastsStore.getState().toasts).toHaveLength(1);
		f.sessions.delete("retry");
		expect(await f.loader.ensureOpenSession("/retry.jsonl")).toMatchObject({ sessionId: "retry" });
		expect(f.sessions.has("retry")).toBe(true);
		expect(pi.openSession).toHaveBeenCalledTimes(2);
	});
	it("failed bundle clears its flight so a new bundle can retry while history retains its own ready protocol", async () => {
		const f = fixture("bundle-retry");
		pi.getTodos.mockRejectedValueOnce(Error("bundle failure")).mockResolvedValue([]);
		await expect(f.loader.loadSessionBundle("bundle-retry")).rejects.toThrow("bundle failure");
		await expect(f.loader.loadSessionBundle("bundle-retry")).resolves.toBeUndefined();
		expect(pi.getTodos).toHaveBeenCalledTimes(2);
		expect(isHistoryReady("bundle-retry")).toBe(true);
	});
	it("late remembered permission success cannot project into a reopened incarnation", async () => {
		const f = fixture("permission"),
			permission = deferred<void>();
		useUiPreferencesStore.setState({ sessionPermissionModes: { permission: "fullAccess" } });
		pi.setPermissionMode.mockReturnValueOnce(permission.promise);
		const loading = f.loader.loadSessionBundle("permission");
		try {
			await vi.waitFor(() => expect(pi.setPermissionMode).toHaveBeenCalledOnce());
			f.loader.forget("permission");
			f.sessions.set("permission", meta("permission", "new"));
			f.modes.set("permission", "default");
			permission.resolve();
			await loading;
			expect(f.modes.get("permission")).toBe("default");
			expect(f.writePermissionMode).toHaveBeenCalledTimes(1);
		} finally {
			permission.resolve();
			await loading;
		}
	});
	it("late GC permission failure cannot reset a new incarnation or toast for it", async () => {
		const f = fixture("gc-permission"),
			permission = deferred<void>();
		f.modes.set("gc-permission", "fullAccess");
		pi.setPermissionMode.mockReturnValue(
			permission.promise.then(() => {
				throw Error("old IPC failure");
			}),
		);
		const restoring = f.loader.restorePermissionMode("gc-permission");
		try {
			f.loader.forget("gc-permission");
			f.sessions.set("gc-permission", meta("gc-permission", "new"));
			f.modes.set("gc-permission", "fullAccess");
			permission.resolve();
			await restoring;
			expect(f.modes.get("gc-permission")).toBe("fullAccess");
			expect(f.writePermissionMode).not.toHaveBeenCalled();
			expect(useToastsStore.getState().toasts).toEqual([]);
		} finally {
			permission.resolve();
			await restoring;
		}
	});
	it("data-only load does not claim either token; noteUserIntent leaves activation valid", async () => {
		const activation = currentNavigationToken(),
			intent = currentUserIntentToken();
		const f = fixture("data");
		pi.openSession.mockResolvedValue(meta("data"));
		await f.loader.ensureOpenSession("/data.jsonl");
		expect(currentNavigationToken()).toBe(activation);
		expect(currentUserIntentToken()).toBe(intent);
		noteUserIntent();
		expect(isLatestNavigation(activation)).toBe(true);
		expect(isLatestUserIntent(intent)).toBe(false);
	});
	it("production imports and four declared data ports enforce narrow dependency direction", () => {
		const source = ts.createSourceFile(
			"session-loading.ts",
			readFileSync(new URL("./session-loading.ts", import.meta.url), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const imports = source.statements
			.filter(ts.isImportDeclaration)
			.map((item) => (item.moduleSpecifier as ts.StringLiteral).text);
		expect(imports).toEqual(
			expect.arrayContaining(["../api", "./session-history", "./transcript", "./ui-preferences", "./toasts"]),
		);
		expect(
			imports.filter((name) => /(?:sessions|projects|workspace|navigation|drafts)(?:$|\/)/.test(name)),
		).toEqual([]);
		const ports = source.statements.find(
			(item): item is ts.InterfaceDeclaration =>
				ts.isInterfaceDeclaration(item) && item.name.text === "SessionDataPorts",
		);
		expect(ports?.members.map((member) => member.name?.getText(source)).sort()).toEqual([
			"isOpen",
			"landMeta",
			"readPermissionMode",
			"writePermissionMode",
		]);
		const leaf = ts.createSourceFile(
			"session-navigation.ts",
			readFileSync(new URL("./session-navigation.ts", import.meta.url), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		expect(leaf.statements.filter(ts.isImportDeclaration)).toEqual([]);
	});
});
