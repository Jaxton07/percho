import type { SessionEvent, SessionMeta } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：sessions store 经 getPi() 访问，测试环境无 preload 注入 */
const piMock = vi.hoisted(() => ({
	createSession: vi.fn(),
	closeSession: vi.fn(),
	saveTabs: vi.fn(() => Promise.resolve()),
	setModel: vi.fn(),
	setThinkingLevel: vi.fn(),
	saveUiState: vi.fn(() => Promise.resolve()),
	pickDirectory: vi.fn(),
	ensureProjectTrust: vi.fn(() => Promise.resolve(true)),
	openSession: vi.fn(),
	getSessionMessages: vi.fn(),
	getFollowUpMessages: vi.fn(() => Promise.resolve([])),
	getTodos: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { DRAFT_SESSION_PREFIX, isDraftSessionId, useSessionsStore } from "./sessions";
import { useTranscriptStore } from "./transcript";

function realMeta(sessionId: string, cwd: string): SessionMeta {
	return {
		sessionId,
		cwd,
		sessionFile: `/tmp/${sessionId}.jsonl`,
		active: true,
		messageCount: 0,
		createdAt: 1,
	};
}

function resetStore() {
	useSessionsStore.setState({
		sessions: [],
		activeSessionId: null,
		cwd: null,
		models: [],
		currentModel: null,
		thinkingLevel: "medium",
		error: null,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetStore();
	useTranscriptStore.setState({ bySession: {} });
});

describe("isDraftSessionId", () => {
	it("识别 draft 前缀 id", () => {
		expect(isDraftSessionId(`${DRAFT_SESSION_PREFIX}abc`)).toBe(true);
		expect(isDraftSessionId("real-1")).toBe(false);
		expect(isDraftSessionId(null)).toBe(false);
		expect(isDraftSessionId(undefined)).toBe(false);
	});
});

describe("createDraftSession", () => {
	it("只建内存 draft tab：不触后端、不落盘", () => {
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().createDraftSession();
		const state = useSessionsStore.getState();
		expect(state.sessions).toHaveLength(1);
		expect(isDraftSessionId(state.sessions[0]?.sessionId)).toBe(true);
		expect(state.sessions[0]?.cwd).toBe("/proj/a");
		expect(state.sessions[0]?.sessionFile).toBeUndefined();
		expect(state.activeSessionId).toBe(state.sessions[0]?.sessionId);
		expect(piMock.createSession).not.toHaveBeenCalled();
		expect(piMock.saveTabs).not.toHaveBeenCalled();
	});

	it("支持显式 cwd（项目页新会话入口）", () => {
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().createDraftSession("/proj/b");
		expect(useSessionsStore.getState().sessions[0]?.cwd).toBe("/proj/b");
		expect(useSessionsStore.getState().cwd).toBe("/proj/b");
	});

	it("无 cwd 时 no-op", () => {
		useSessionsStore.getState().createDraftSession();
		expect(useSessionsStore.getState().sessions).toHaveLength(0);
	});
});

describe("setDraftCwd", () => {
	it("活跃 tab 是 draft：同步更新 draft 条目与全局 cwd", () => {
		useSessionsStore.getState().createDraftSession("/proj/a");
		useSessionsStore.getState().setDraftCwd("/proj/b");
		const state = useSessionsStore.getState();
		expect(state.sessions[0]?.cwd).toBe("/proj/b");
		expect(state.cwd).toBe("/proj/b");
	});

	it("活跃 tab 是真实会话：只改全局默认，不动会话条目", () => {
		useSessionsStore.setState({ sessions: [realMeta("r1", "/proj/a")], activeSessionId: "r1" });
		useSessionsStore.getState().setDraftCwd("/proj/b");
		const state = useSessionsStore.getState();
		expect(state.sessions[0]?.cwd).toBe("/proj/a");
		expect(state.cwd).toBe("/proj/b");
	});
});

describe("draft 转正（createSession + replaceDraftId）", () => {
	it("用 draft 的 cwd 创建后端会话，原地替换保持 tab 位置", async () => {
		piMock.createSession.mockResolvedValue(realMeta("real-1", "/proj/b"));
		useSessionsStore.getState().createDraftSession("/proj/a");
		useSessionsStore.getState().createDraftSession("/proj/a");
		const draftId = useSessionsStore.getState().activeSessionId;
		if (!draftId) throw new Error("no draft");
		useSessionsStore.getState().setDraftCwd("/proj/b");

		await useSessionsStore.getState().createSession("/proj/b", draftId);

		const state = useSessionsStore.getState();
		expect(piMock.createSession).toHaveBeenCalledWith({ cwd: "/proj/b", thinkingLevel: "medium" });
		expect(state.sessions).toHaveLength(2);
		expect(state.sessions[1]?.sessionId).toBe("real-1");
		expect(state.sessions[1]?.cwd).toBe("/proj/b");
		expect(state.activeSessionId).toBe("real-1");
		// 转正后落盘 tabs.json
		expect(piMock.saveTabs).toHaveBeenCalledWith({
			files: ["/tmp/real-1.jsonl"],
			activeFile: "/tmp/real-1.jsonl",
		});
	});

	it("创建失败：draft tab 保留，错误透出", async () => {
		piMock.createSession.mockRejectedValue(new Error("boom"));
		useSessionsStore.getState().createDraftSession("/proj/a");
		const draftId = useSessionsStore.getState().activeSessionId;
		await useSessionsStore.getState().createSession("/proj/a", draftId ?? undefined);
		const state = useSessionsStore.getState();
		expect(state.sessions[0]?.sessionId).toBe(draftId);
		expect(state.error).toBe("boom");
	});
});

describe("closeSession", () => {
	it("关闭 draft：纯本地移除，不调后端、不落盘", async () => {
		useSessionsStore.getState().createDraftSession("/proj/a");
		const draftId = useSessionsStore.getState().activeSessionId;
		if (!draftId) throw new Error("no draft");
		await useSessionsStore.getState().closeSession(draftId);
		const state = useSessionsStore.getState();
		expect(piMock.closeSession).not.toHaveBeenCalled();
		expect(piMock.saveTabs).not.toHaveBeenCalled();
		expect(state.sessions).toHaveLength(0);
		expect(state.activeSessionId).toBeNull();
	});

	it("关闭真实会话：正常走后端并落盘", async () => {
		useSessionsStore.setState({ sessions: [realMeta("r1", "/proj/a")], activeSessionId: "r1" });
		await useSessionsStore.getState().closeSession("r1");
		expect(piMock.closeSession).toHaveBeenCalledWith("r1");
		expect(piMock.saveTabs).toHaveBeenCalled();
	});

	it("关闭跨项目激活会话：cwd 同步切到剩余会话的项目（B5）", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("r1", "/proj/a"), realMeta("r2", "/proj/b")],
			activeSessionId: "r2",
			cwd: "/proj/b",
		});
		await useSessionsStore.getState().closeSession("r2");
		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBe("r1");
		expect(state.cwd).toBe("/proj/a");
	});

	it("关闭后台会话：active 与 cwd 不变", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("r1", "/proj/a"), realMeta("r2", "/proj/b")],
			activeSessionId: "r1",
			cwd: "/proj/a",
		});
		await useSessionsStore.getState().closeSession("r2");
		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBe("r1");
		expect(state.cwd).toBe("/proj/a");
	});
});

describe("switchSession", () => {
	it("切到 draft：cwd 恢复为 draft 的目录，但不落盘；切回真实会话恢复并落盘", () => {
		useSessionsStore.setState({
			sessions: [realMeta("r1", "/proj/a")],
			activeSessionId: "r1",
			cwd: "/proj/a",
		});
		useSessionsStore.getState().createDraftSession("/proj/b");
		const draftId = useSessionsStore.getState().activeSessionId;
		if (!draftId) throw new Error("no draft");

		vi.clearAllMocks();
		useSessionsStore.getState().switchSession("r1");
		expect(useSessionsStore.getState().cwd).toBe("/proj/a");
		expect(piMock.saveTabs).toHaveBeenCalledTimes(1);

		useSessionsStore.getState().switchSession(draftId);
		expect(useSessionsStore.getState().cwd).toBe("/proj/b");
		expect(piMock.saveTabs).toHaveBeenCalledTimes(1);
	});
});

describe("openFromHistory", () => {
	it("运行中子会话已收到实时事件时保留流式进度，不回放静态历史覆盖", async () => {
		piMock.openSession.mockResolvedValue(realMeta("sub-1", "/proj"));
		useTranscriptStore.getState().applyEvent("sub-1", { type: "agent_start" } as SessionEvent);

		await useSessionsStore.getState().openFromHistory("/tmp/sub-1.jsonl");

		expect(piMock.getSessionMessages).not.toHaveBeenCalled();
		expect(useTranscriptStore.getState().bySession["sub-1"]?.agentActive).toBe(true);
		expect(useSessionsStore.getState().activeSessionId).toBe("sub-1");
	});
});

describe("reorderSessions（拖拽排序）", () => {
	const draftMeta = (name: string): SessionMeta => ({
		...realMeta(name, "/p"),
		sessionId: `${DRAFT_SESSION_PREFIX}x`,
		sessionFile: undefined,
	});

	it("向后拖：a 跨过 draft 到末尾，并按新视觉序落盘", () => {
		useSessionsStore.setState({
			sessions: [realMeta("a", "/p"), draftMeta("dx"), realMeta("b", "/p")],
			cwd: "/p",
		});
		useSessionsStore.getState().reorderSessions("a", "b");
		expect(useSessionsStore.getState().sessions.map((s) => s.sessionId)).toEqual([
			`${DRAFT_SESSION_PREFIX}x`,
			"b",
			"a",
		]);
		// files 只含真实会话，顺序 = 去掉 draft 后的视觉序
		expect(piMock.saveTabs).toHaveBeenCalledWith({
			files: ["/tmp/b.jsonl", "/tmp/a.jsonl"],
			activeFile: null,
		});
	});

	it("向前拖：插入到目标原索引，中间项整体右移（arrayMove 语义，与落位视觉一致）", () => {
		useSessionsStore.setState({ sessions: [realMeta("a", "/p"), draftMeta("dx"), realMeta("b", "/p")] });
		useSessionsStore.getState().reorderSessions("b", "a");
		expect(useSessionsStore.getState().sessions.map((s) => s.sessionId)).toEqual([
			"b",
			"a",
			`${DRAFT_SESSION_PREFIX}x`,
		]);
	});

	it("原地/未知 id 不变序也不落盘", () => {
		useSessionsStore.setState({ sessions: [realMeta("a", "/p"), realMeta("b", "/p")] });
		useSessionsStore.getState().reorderSessions("a", "a");
		useSessionsStore.getState().reorderSessions("nope", "b");
		useSessionsStore.getState().reorderSessions("a", "nope");
		expect(useSessionsStore.getState().sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
		expect(piMock.saveTabs).not.toHaveBeenCalled();
	});
});

describe("模型/思考级别", () => {
	it("draft 下切换模型：只更新全局默认与 draft 条目，不调后端 setModel", async () => {
		useSessionsStore.getState().createDraftSession("/proj/a");
		await useSessionsStore.getState().setCurrentModel("p", "m");
		const state = useSessionsStore.getState();
		expect(piMock.setModel).not.toHaveBeenCalled();
		expect(state.currentModel).toEqual({ provider: "p", modelId: "m" });
		expect(state.sessions[0]?.model).toEqual({ provider: "p", modelId: "m" });
		expect(piMock.saveUiState).toHaveBeenCalled();
	});
});
