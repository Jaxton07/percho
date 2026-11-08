import type { SessionMeta } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	archive: vi.fn(),
	forget: vi.fn(),
	unpin: vi.fn(),
	remove: vi.fn(),
	invalidate: vi.fn(),
	toast: vi.fn(),
	active: "a" as string | null,
	token: 1,
	intent: 1,
	entry: undefined as any,
	topics: [] as string[],
	projects: [{ sessionId: "a" }, { sessionId: "b" }],
	catalogs: {},
}));
vi.mock("../environment-api", () => ({ getExecutionApi: () => ({ archiveSession: m.archive }) }));
vi.mock("./channel-subscriptions", () => ({
	useChannelSubscriptionsStore: { getState: () => ({ bySession: { a: { topics: m.topics } } }) },
}));
vi.mock("./projects", () => ({
	useProjectsStore: {
		setState: (fn: any) => {
			m.projects = fn({ allSessions: m.projects }).allSessions;
		},
	},
}));
vi.mock("./remote-connection", () => ({
	useRemoteConnectionStore: { getState: () => ({ status: { state: "disconnected" } }) },
}));
vi.mock("./session-catalog", () => ({
	useSessionCatalogStore: {
		getState: () => ({ invalidate: m.invalidate }),
		setState: (fn: any) => fn({ byEnvironment: m.catalogs }),
	},
}));
vi.mock("./session-navigation", () => ({
	currentNavigationToken: () => m.token,
	currentUserIntentToken: () => m.intent,
	isLatestNavigation: (x: number) => x === m.token,
	isLatestUserIntent: (x: number) => x === m.intent,
}));
vi.mock("./session-workspace", () => ({
	useSessionWorkspaceStore: { getState: () => ({ removeMember: m.remove }) },
}));
vi.mock("./sessions", () => ({
	useSessionsStore: { getState: () => ({ activeSessionId: m.active, forgetArchivedSession: m.forget }) },
}));
vi.mock("./toasts", () => ({ pushToast: m.toast }));
vi.mock("./transcript", () => ({ useTranscriptStore: { getState: () => ({ bySession: { a: m.entry } }) } }));
vi.mock("./ui-preferences", () => ({ useUiPreferencesStore: { getState: () => ({ unpin: m.unpin }) } }));

import { archiveDisabledReason, archiveHasSubscriptions, archiveSession } from "./session-archive";

const meta = {
	sessionId: "a",
	sessionFile: "/a",
	cwd: "/p",
	messageCount: 1,
	archiveRevision: 3,
} as SessionMeta;
const deferred = () => {
	let resolve!: (value: any) => void;
	const promise = new Promise<any>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
beforeEach(() => {
	vi.clearAllMocks();
	m.active = "a";
	m.token = 1;
	m.intent = 1;
	m.entry = undefined;
	m.topics = [];
	m.projects = [{ sessionId: "a" }, { sessionId: "b" }];
});
describe("archive session", () => {
	it("archives current session and removes its cached resources", async () => {
		const d = deferred();
		m.archive.mockReturnValue(d.promise);
		const done = archiveSession(meta);
		expect(m.archive).toHaveBeenCalledWith({ sessionId: "a", sessionFile: "/a", expectedRevision: 3 });
		d.resolve({ archived: true });
		await done;
		expect(m.forget).toHaveBeenCalledWith("a", true);
		expect(m.unpin).toHaveBeenCalledWith("a");
		expect(m.remove).toHaveBeenCalledWith("a");
		expect(m.projects).toEqual([{ sessionId: "b" }]);
		expect(m.invalidate).toHaveBeenCalled();
	});
	it("does not change focus for a background session or navigation during the request", async () => {
		m.active = "b";
		m.archive.mockResolvedValue({ archived: true });
		await archiveSession(meta);
		expect(m.forget).toHaveBeenLastCalledWith("a", false);
		m.active = "a";
		const d = deferred();
		m.archive.mockReturnValue(d.promise);
		const done = archiveSession(meta);
		m.active = "b";
		m.token++;
		d.resolve({ archived: true });
		await done;
		expect(m.forget).toHaveBeenLastCalledWith("a", false);
	});
	it("rejects busy and unsaved sessions and exposes the subscription warning", async () => {
		m.entry = { phase: "streaming", followUpQueue: [], pendingPermissions: [], pendingDialogs: [] };
		expect(archiveDisabledReason(meta)).toBe("busy");
		await archiveSession(meta);
		expect(m.archive).not.toHaveBeenCalled();
		m.entry = undefined;
		expect(archiveDisabledReason({ ...meta, messageCount: 0 })).toBe("history");
		m.topics = ["topic"];
		expect(archiveHasSubscriptions("a")).toBe(true);
	});
	it("reports incomplete cleanup as a warning", async () => {
		m.archive.mockResolvedValue({ archived: true, cleanupPending: true });
		await archiveSession(meta);
		expect(m.toast).toHaveBeenCalledWith("warning", "sessionArchive.cleanupPending");
	});
});
