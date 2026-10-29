import {
	environmentEntityKey,
	LOCAL_ENVIRONMENT,
	type RemoteConnectionStatus,
	type TaskNotificationClick,
} from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	listener: undefined as ((event: TaskNotificationClick) => void) | undefined,
	ready: vi.fn(async (_args: { ready: boolean }) => {}),
	off: vi.fn(),
	open: vi.fn(),
	switchSession: vi.fn(),
	toast: vi.fn(),
	sessions: [] as { sessionId: string }[],
	status: { revision: 1, state: "disconnected" } as RemoteConnectionStatus,
	getStatus: vi.fn(),
	accept: vi.fn(),
}));
vi.mock("../api", () => ({
	getPi: () => ({
		onTaskNotificationClick: (listener: (event: TaskNotificationClick) => void) => {
			fixture.listener = listener;
			return fixture.off;
		},
		setTaskNotificationNavigationReady: fixture.ready,
		remoteGetStatus: fixture.getStatus,
	}),
}));
vi.mock("./sessions", () => ({
	useSessionsStore: {
		getState: () => ({
			sessions: fixture.sessions,
			openFromHistory: fixture.open,
			switchSession: fixture.switchSession,
		}),
	},
}));
vi.mock("./remote-connection", () => ({
	useRemoteConnectionStore: { getState: () => ({ status: fixture.status, accept: fixture.accept }) },
}));
vi.mock("./toasts", () => ({ pushToast: fixture.toast }));

import { noteUserIntent } from "./session-navigation";
import { initTaskNotificationNavigation } from "./task-notification-navigation";

const target = { environment: LOCAL_ENVIRONMENT, sessionId: "s", sessionFile: "/fixture/s.jsonl" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
	vi.clearAllMocks();
	fixture.sessions = [];
	fixture.status = { revision: 1, state: "disconnected" } as RemoteConnectionStatus;
	fixture.getStatus.mockImplementation(async () => fixture.status);
	fixture.accept.mockImplementation((status) => {
		fixture.status = status;
	});
	fixture.open.mockResolvedValue({ ok: true, meta: { sessionId: "s" } });
});
describe("notification click entry point", () => {
	it("keeps remote history routing and invalidates navigation on a new connection revision", async () => {
		const environment = { kind: "ssh", connectionId: "fixture", environmentId: "one" } as const;
		fixture.status = { revision: 2, state: "connected", environment } as RemoteConnectionStatus;
		let guard: ((meta: { sessionId: string }) => boolean) | undefined;
		fixture.open.mockImplementation((_file, check) => {
			guard = check;
			return new Promise(() => {});
		});
		const off = initTaskNotificationNavigation();
		fixture.listener?.({ target: { ...target, environment }, queued: false });
		await flush();
		const id = environmentEntityKey(environment, "s");
		expect(fixture.open).toHaveBeenCalledWith(
			environmentEntityKey(environment, target.sessionFile),
			expect.any(Function),
		);
		expect(guard?.({ sessionId: id })).toBe(true);
		fixture.status = { ...fixture.status, revision: 3 };
		expect(guard?.({ sessionId: id })).toBe(false);
		off();
	});
	it("does not connect or open local history for an unavailable remote target", async () => {
		const off = initTaskNotificationNavigation();
		fixture.listener?.({
			target: { ...target, environment: { kind: "ssh", connectionId: "fixture", environmentId: "one" } },
			queued: false,
		});
		await flush();
		expect(fixture.open).not.toHaveBeenCalled();
		expect(fixture.switchSession).not.toHaveBeenCalled();
		expect(fixture.toast).toHaveBeenCalledWith("warning", "notifications.targetUnavailable");
		off();
	});
	it("opens an unloaded target from an empty page after installing its listener", async () => {
		const off = initTaskNotificationNavigation();
		expect(fixture.listener).toBeTypeOf("function");
		expect(fixture.ready).toHaveBeenCalledWith({ ready: true });
		fixture.listener?.({ target, queued: true });
		await flush();
		expect(fixture.open).toHaveBeenCalledWith("/fixture/s.jsonl", expect.any(Function));
		off();
		expect(fixture.off).toHaveBeenCalledOnce();
		expect(fixture.ready).toHaveBeenLastCalledWith({ ready: false });
	});
	it("does not overwrite user navigation with a click queued before readiness", async () => {
		const off = initTaskNotificationNavigation();
		noteUserIntent();
		fixture.listener?.({ target, queued: true });
		await flush();
		expect(fixture.open).not.toHaveBeenCalled();
		off();
	});
	it("switches existing sessions without reopening and explains invalid targets", async () => {
		fixture.sessions = [{ sessionId: "s" }];
		const off = initTaskNotificationNavigation();
		fixture.listener?.({ target, queued: false });
		await flush();
		expect(fixture.switchSession).toHaveBeenCalledWith("s");
		fixture.listener?.({ target: null, queued: false });
		expect(fixture.toast).toHaveBeenCalledWith("warning", "notifications.targetUnavailable");
		off();
	});
	it("invalidates the commit guard after unmount without manufacturing history readiness", async () => {
		let guard: ((meta: { sessionId: string }) => boolean) | undefined;
		fixture.open.mockImplementation((_file, check) => {
			guard = check;
			return new Promise(() => {});
		});
		const off = initTaskNotificationNavigation();
		fixture.listener?.({ target, queued: false });
		await flush();
		expect(guard?.({ sessionId: "s" })).toBe(true);
		off();
		expect(guard?.({ sessionId: "s" })).toBe(false);
	});
});
