import {
	emptyTranscript,
	reduceEvent,
	type SessionHistoryPage,
	type SessionHistoryWindow,
	type UIMessage,
} from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginSessionBaseline, forgetSessionBoundary } from "./session-event-boundary";
import { clearSessionHistory, finishSessionHistory } from "./session-history";
import { installOlderHistory, loadOlderHistory } from "./session-history-paging";
import { useTranscriptStore } from "./transcript";

const api = vi.hoisted(() => ({ getSessionHistoryPage: vi.fn(), markSessionHistoryReady: vi.fn() }));
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
	seed();
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
