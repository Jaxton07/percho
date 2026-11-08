import {
	emptyTranscript,
	environmentEntityKey,
	reduceEvent,
	type SessionHistoryPage,
	type SessionHistoryWindow,
	type SessionNavigation,
	type UIMessage,
} from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginSessionBaseline, forgetSessionBoundary } from "./session-event-boundary";
import { clearSessionHistory, finishSessionHistory, reloadSessionHistory } from "./session-history";
import {
	installOlderHistory,
	loadHistoryThrough,
	loadOlderHistory,
	loadSessionNavigation,
} from "./session-history-paging";
import { useTranscriptStore } from "./transcript";

const api = vi.hoisted(() => ({
	getSessionBaseline: vi.fn(),
	getSessionHistoryPage: vi.fn(),
	getSessionNavigation: vi.fn(),
	markSessionHistoryReady: vi.fn(),
}));
vi.mock("../environment-api", () => ({ getExecutionApi: () => api }));
const message = (id: string): UIMessage => ({
	kind: "user",
	id,
	entryId: id,
	text: id,
	images: [],
	timestamp: 1,
});
const window = (generation = "one"): SessionHistoryWindow => ({
	generation,
	sourceVersion: "source",
	hydrationToken: "open",
	hasOlder: true,
	cursor: `cursor:${generation}`,
	pageEntries: 2,
	pageTurns: 1,
});
const page = (generation = "one"): SessionHistoryPage => ({
	messages: [message(`older:${generation}`)],
	history: { ...window(generation), hasOlder: false, cursor: undefined },
});
function seed(generation = "one") {
	useTranscriptStore.setState({
		bySession: {
			session: {
				...emptyTranscript(),
				history: window(generation),
				messages: [message("tail")],
				agentActive: true,
				followUpQueue: ["queued"],
				pendingPermissions: [],
				pendingDialogs: [],
			},
		},
	});
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { resolve, reject, promise };
}
beforeEach(() => {
	vi.clearAllMocks();
	forgetSessionBoundary("session");
	clearSessionHistory("session");
	api.markSessionHistoryReady.mockResolvedValue(undefined);
	api.getSessionNavigation.mockResolvedValue({ entries: [] } satisfies SessionNavigation);
	api.getSessionHistoryPage.mockReset();
	seed();
});

describe("历史代隔离", () => {
	it("真实重装后不等待旧目标请求，旧等待链及迟到成功不能污染新页", async () => {
		const old = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValueOnce(old.promise);
		const target = loadHistoryThrough("session", "missing");
		await Promise.resolve();
		const waiting = loadOlderHistory("session");
		api.getSessionBaseline.mockResolvedValueOnce({
			hydrationToken: "open-two",
			meta: {
				sessionId: "session",
				sessionFile: "/session",
				cwd: "/",
				active: true,
				messageCount: 0,
				createdAt: 1,
			},
			sequence: 0,
			permissionMode: "default",
			transcript: { ...emptyTranscript(), messages: [message("new-tail")], history: window("two") },
		});
		await reloadSessionHistory("session", () => true);
		api.getSessionHistoryPage.mockResolvedValueOnce(page("two"));
		await loadOlderHistory("session");
		expect(useTranscriptStore.getState().bySession.session?.messages.map((item) => item.id)).toEqual([
			"older:two",
			"new-tail",
		]);
		old.resolve(page());
		await Promise.all([target, waiting]);
		expect(api.getSessionHistoryPage).toHaveBeenCalledTimes(2);
		expect(useTranscriptStore.getState().bySession.session?.messages.map((item) => item.id)).toEqual([
			"older:two",
			"new-tail",
		]);
	});

	it.each(["sourceVersion", "hydrationToken"] as const)("%s 换代和旧失败不影响新请求", async (field) => {
		const old = deferred<SessionHistoryPage>(),
			fresh = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
		const first = loadHistoryThrough("session", "target");
		await Promise.resolve();
		useTranscriptStore.setState((state) => {
			const current = state.bySession.session;
			if (!current) return state;
			return {
				bySession: { ...state.bySession, session: { ...current, history: { ...window(), [field]: "new" } } },
			};
		});
		const second = loadOlderHistory("session");
		await Promise.resolve();
		old.reject(new Error("obsolete"));
		await first;
		expect(loadOlderHistory("session")).toBe(second);
		expect(useTranscriptStore.getState().bySession.session?.historyFetch?.loading).toBe(true);
		const response = page();
		response.history[field] = "new";
		fresh.resolve(response);
		await second;
		expect(useTranscriptStore.getState().bySession.session?.messages[0]?.id).toBe("older:one");
	});

	it("关闭重开同 SID 后旧等待链不再发请求", async () => {
		const old = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValueOnce(old.promise);
		const first = loadHistoryThrough("session", "target");
		await Promise.resolve();
		const waiting = loadOlderHistory("session");
		clearSessionHistory("session");
		seed();
		api.getSessionHistoryPage.mockResolvedValueOnce(page());
		await loadOlderHistory("session");
		old.resolve(page());
		await Promise.all([first, waiting]);
		expect(api.getSessionHistoryPage).toHaveBeenCalledTimes(2);
	});

	it("不同环境的相同 SID 分页互不等待", async () => {
		const remote = environmentEntityKey(
			{ kind: "ssh", connectionId: "connection", environmentId: "remote" },
			"session",
		);
		useTranscriptStore.setState((state) => ({
			bySession: {
				...state.bySession,
				[remote]: {
					...emptyTranscript(),
					pendingPermissions: [],
					pendingDialogs: [],
					history: window(),
					messages: [message("remote-tail")],
				},
			},
		}));
		const old = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValueOnce(old.promise);
		const first = loadHistoryThrough("session", "target");
		await Promise.resolve();
		api.getSessionHistoryPage.mockResolvedValueOnce(page());
		await loadOlderHistory(remote);
		expect(useTranscriptStore.getState().bySession[remote]?.messages.map((item) => item.id)).toEqual([
			"older:one",
			"remote-tail",
		]);
		old.resolve(page());
		await first;
		clearSessionHistory(remote);
	});
});

describe("导航与目标页", () => {
	it("加载导航并在旧远端或 generation 变化时返回 null", async () => {
		await expect(loadSessionNavigation("session")).resolves.toEqual({ entries: [] });
		api.getSessionNavigation.mockRejectedValueOnce(new Error("Unknown or desktop-only method"));
		await expect(loadSessionNavigation("session")).resolves.toBeNull();
		api.getSessionHistoryPage.mockResolvedValueOnce(page());
		await loadOlderHistory("session");
		expect(useTranscriptStore.getState().bySession.session?.messages[0]?.id).toBe("older:one");
		const pending = deferred<SessionNavigation>();
		api.getSessionNavigation.mockReturnValueOnce(pending.promise);
		const request = loadSessionNavigation("session");
		seed("two");
		pending.resolve({ entries: [] });
		await expect(request).resolves.toBeNull();
	});
	it("逐页加载目标并复用普通分页", async () => {
		api.getSessionHistoryPage
			.mockResolvedValueOnce({
				messages: [message("middle")],
				history: { ...window(), cursor: "next-cursor" },
			})
			.mockResolvedValueOnce(page());
		await expect(loadHistoryThrough("session", "older:one")).resolves.toBe(true);
		expect(api.getSessionHistoryPage.mock.calls).toEqual([
			[{ sessionId: "session", cursor: "cursor:one" }],
			[{ sessionId: "session", cursor: "next-cursor" }],
		]);
	});
	it("取消在途跳转后不再续页", async () => {
		const pending = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValueOnce(pending.promise);
		let current = true;
		const beforePrepend = vi.fn();
		const result = loadHistoryThrough("session", "target", beforePrepend, () => current);
		await Promise.resolve();
		current = false;
		pending.resolve({ messages: [message("middle")], history: { ...window(), cursor: "next" } });
		await expect(result).resolves.toBe(false);
		expect(beforePrepend).not.toHaveBeenCalled();
		expect(api.getSessionHistoryPage).toHaveBeenCalledTimes(1);
		expect(useTranscriptStore.getState().bySession.session?.historyFetch?.error).toBeUndefined();
	});
	it("新目标共享在途普通页，旧意图失效后仍可继续", async () => {
		const pending = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page());
		let current = true;
		const old = loadHistoryThrough("session", "missing", undefined, () => current);
		await Promise.resolve();
		current = false;
		const fresh = loadHistoryThrough("session", "older:one");
		pending.resolve({ messages: [message("middle")], history: { ...window(), cursor: "next" } });
		await expect(old).resolves.toBe(false);
		await expect(fresh).resolves.toBe(true);
		expect(api.getSessionHistoryPage).toHaveBeenCalledTimes(2);
	});
	it("目标不存在不记分页错误，真实读取失败仍可重试", async () => {
		api.getSessionHistoryPage.mockResolvedValueOnce(page());
		await expect(loadHistoryThrough("session", "missing")).resolves.toBe(false);
		expect(useTranscriptStore.getState().bySession.session?.historyFetch?.error).toBeUndefined();
		seed();
		api.getSessionHistoryPage.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(page());
		await expect(loadHistoryThrough("session", "older:one")).resolves.toBe(false);
		expect(useTranscriptStore.getState().bySession.session?.historyFetch?.error).toBe("Offline");
		await expect(loadHistoryThrough("session", "older:one")).resolves.toBe(true);
	});
	it("没有新增消息时停止，不记分页错误", async () => {
		api.getSessionHistoryPage.mockResolvedValueOnce({
			messages: [message("tail")],
			history: { ...window(), cursor: "next" },
		});
		await expect(loadHistoryThrough("session", "missing")).resolves.toBe(false);
		expect(api.getSessionHistoryPage).toHaveBeenCalledTimes(1);
		expect(useTranscriptStore.getState().bySession.session?.historyFetch?.error).toBeUndefined();
	});
	it("重复游标时停止，不记分页错误", async () => {
		api.getSessionHistoryPage.mockResolvedValueOnce({ messages: [message("middle")], history: window() });
		await expect(loadHistoryThrough("session", "missing")).resolves.toBe(false);
		expect(api.getSessionHistoryPage).toHaveBeenCalledTimes(1);
		expect(useTranscriptStore.getState().bySession.session?.historyFetch?.error).toBeUndefined();
	});
});

describe("旧页前插与活动态隔离", () => {
	it("同一hydrationToken只ACK一次；全量重装也不重复，重开新实例可确认", () => {
		finishSessionHistory("session", "open");
		finishSessionHistory("session", "open");
		finishSessionHistory("session");
		expect(api.markSessionHistoryReady).toHaveBeenCalledTimes(1);
		clearSessionHistory("session");
		finishSessionHistory("session", "reopened");
		expect(api.markSessionHistoryReady).toHaveBeenCalledTimes(2);
		expect(api.markSessionHistoryReady).toHaveBeenLastCalledWith({
			sessionId: "session",
			hydrationToken: "reopened",
		});
	});
	it("同页单飞，期间queue/权限/活动态保持，旧页不ACK且同页安装幂等", async () => {
		const reply = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValue(reply.promise);
		const first = loadOlderHistory("session"),
			second = loadOlderHistory("session");
		expect(first).toBe(second);
		await Promise.resolve();
		expect(api.getSessionHistoryPage).toHaveBeenCalledTimes(1);
		useTranscriptStore.getState().setFollowUpQueue("session", ["new queued"]);
		const streaming = reduceEvent(emptyTranscript(), { type: "turn_start" }).streaming;
		if (!streaming) throw new Error("No active streaming state");
		useTranscriptStore.setState((state) => {
			const session = state.bySession.session;
			if (!session) return state;
			return {
				bySession: {
					...state.bySession,
					session: {
						...session,
						streaming: {
							...streaming,
							text: "Arrived while the old page was loading",
							tools: [
								{
									key: "live-tool",
									id: "live-call",
									name: "read",
									args: "{}",
									output: "partial",
									state: "running",
								},
							],
						},
					},
				},
			};
		});
		const current = useTranscriptStore.getState().bySession.session;
		reply.resolve(page());
		await first;
		const result = useTranscriptStore.getState().bySession.session;
		expect(result?.messages.map((message) => message.id)).toEqual(["older:one", "tail"]);
		expect(result?.followUpQueue).toEqual(["new queued"]);
		expect(result?.agentActive).toBe(true);
		expect(result?.streaming).toBe(current?.streaming);
		expect(result?.streaming?.text).toBe("Arrived while the old page was loading");
		expect(result?.pendingPermissions).toBe(current?.pendingPermissions);
		expect(result?.pendingDialogs).toBe(current?.pendingDialogs);
		expect(installOlderHistory("session", "one", "cursor:one", page())).toBe(false);
		expect(api.markSessionHistoryReady).not.toHaveBeenCalled();
	});
	it("同SID replace后的旧回应/错误/finally不覆盖新代，也不吞新代单飞", async () => {
		const old = deferred<SessionHistoryPage>(),
			fresh = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
		const first = loadOlderHistory("session");
		await Promise.resolve();
		seed("two");
		const second = loadOlderHistory("session");
		await Promise.resolve();
		old.reject(new Error("Old response"));
		await first;
		expect(useTranscriptStore.getState().bySession.session?.historyFetch?.loading).toBe(true);
		expect(loadOlderHistory("session")).toBe(second);
		fresh.resolve(page("two"));
		await second;
		expect(useTranscriptStore.getState().bySession.session?.messages.map((message) => message.id)).toEqual([
			"older:two",
			"tail",
		]);
	});
	it("失败保留游标可重试；关闭/GC后的迟到响应不重建会话", async () => {
		api.getSessionHistoryPage.mockRejectedValueOnce(new Error("Offline"));
		await loadOlderHistory("session");
		expect(useTranscriptStore.getState().bySession.session?.historyFetch?.error).toBe("Offline");
		const reply = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValue(reply.promise);
		const pending = loadOlderHistory("session");
		await Promise.resolve();
		useTranscriptStore.getState().resetSession("session");
		reply.resolve(page());
		await pending;
		expect(useTranscriptStore.getState().bySession.session).toBeUndefined();
	});
	it("整体replace开始后在途旧页立即失效，不等新基线返回", async () => {
		const reply = deferred<SessionHistoryPage>();
		api.getSessionHistoryPage.mockReturnValue(reply.promise);
		const callback = vi.fn(),
			pending = loadOlderHistory("session", callback);
		await Promise.resolve();
		beginSessionBaseline("session");
		reply.resolve(page());
		await pending;
		expect(useTranscriptStore.getState().bySession.session?.messages.map((message) => message.id)).toEqual([
			"tail",
		]);
		expect(callback).not.toHaveBeenCalled();
	});
	it("来源或打开令牌不匹配时不安装，不动现有消息", () => {
		const mismatched = page();
		mismatched.history.hydrationToken = "different-open";
		expect(installOlderHistory("session", "one", "cursor:one", mismatched)).toBe(false);
		expect(useTranscriptStore.getState().bySession.session?.messages.map((message) => message.id)).toEqual([
			"tail",
		]);
	});
});
