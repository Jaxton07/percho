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
	forkSession: vi.fn(),
	getSessionMessages: vi.fn(() => Promise.resolve([])),
	getFollowUpMessages: vi.fn(() => Promise.resolve([])),
	getTodos: vi.fn(() => Promise.resolve([])),
	getPermissionMode: vi.fn(() => Promise.resolve("default" as const)),
	setPermissionMode: vi.fn(() => Promise.resolve()),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { DRAFT_SESSION_PREFIX, isDraftSessionId, useSessionsStore } from "./sessions";
import { useToastsStore } from "./toasts";
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
		trustVersion: 0,
		permissionModes: {},
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

	it("创建失败：draft tab 保留，toast 提示（不残留 store 错误态）", async () => {
		piMock.createSession.mockRejectedValue(new Error("boom"));
		useSessionsStore.getState().createDraftSession("/proj/a");
		const draftId = useSessionsStore.getState().activeSessionId;
		await useSessionsStore.getState().createSession("/proj/a", draftId ?? undefined);
		const state = useSessionsStore.getState();
		expect(state.sessions[0]?.sessionId).toBe(draftId);
		expect(
			useToastsStore
				.getState()
				.toasts.some(
					(t) =>
						t.severity === "warning" && t.titleKey === "toast.sessionCreateFailed" && t.detail === "boom",
				),
		).toBe(true);
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
		// skipHistoryIfLive 只跳过历史，队列/todo 仍照常装载
		expect(piMock.getFollowUpMessages).toHaveBeenCalledTimes(1);
		expect(piMock.getTodos).toHaveBeenCalledTimes(1);
		expect(useTranscriptStore.getState().bySession["sub-1"]?.agentActive).toBe(true);
		expect(useSessionsStore.getState().activeSessionId).toBe("sub-1");
	});

	it("非 live 会话：历史/队列/todo 各恰好装载一次", async () => {
		piMock.openSession.mockResolvedValue(realMeta("hist-1", "/proj"));
		piMock.getSessionMessages.mockResolvedValue([]);

		await useSessionsStore.getState().openFromHistory("/tmp/hist-1.jsonl");

		expect(piMock.getSessionMessages).toHaveBeenCalledTimes(1);
		expect(piMock.getFollowUpMessages).toHaveBeenCalledTimes(1);
		expect(piMock.getTodos).toHaveBeenCalledTimes(1);
		expect(useTranscriptStore.getState().bySession["hist-1"]).toBeDefined();
	});
});

describe("forkSession", () => {
	it("装载三件套失败：toast 提示（异常穿透不残留 store 错误态）", async () => {
		piMock.getSessionMessages.mockRejectedValue(new Error("bundle boom"));
		useSessionsStore.setState({
			sessions: [realMeta("r1", "/proj")],
			activeSessionId: "r1",
		});
		piMock.forkSession.mockResolvedValue(realMeta("fork-1", "/proj"));

		await useSessionsStore.getState().forkSession({});

		expect(
			useToastsStore
				.getState()
				.toasts.some(
					(t) => t.severity === "warning" && t.titleKey === "toast.forkFailed" && t.detail === "bundle boom",
				),
		).toBe(true);
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

describe("乐观会话设置（optimisticSessionSetting 骨架）", () => {
	it("切模型成功：全局 + 会话条目乐观更新，ui-state 持久化", async () => {
		useSessionsStore.setState({
			models: [{ provider: "deepseek", providerName: "DeepSeek", id: "v4", label: "V4", authed: true }],
			sessions: [realMeta("s1", "/p")],
			activeSessionId: "s1",
		});
		await useSessionsStore.getState().setCurrentModel("deepseek", "v4");
		expect(piMock.setModel).toHaveBeenCalledWith("s1", "deepseek", "v4");
		expect(useSessionsStore.getState().currentModel).toEqual({ provider: "deepseek", modelId: "v4" });
		expect(useSessionsStore.getState().sessions[0]?.model).toEqual({ provider: "deepseek", modelId: "v4" });
		expect(piMock.saveUiState).toHaveBeenCalledWith({
			currentModel: { provider: "deepseek", modelId: "v4" },
			thinkingLevel: "medium",
		});
	});

	it("切模型失败：全局 + 会话条目整体回滚，ui-state 以旧值重新持久化", async () => {
		const previousModel = { provider: "deepseek", modelId: "v4" };
		useSessionsStore.setState({
			models: [{ provider: "anthropic", providerName: "Anthropic", id: "sonnet", label: "Sonnet", authed: true }],
			sessions: [{ ...realMeta("s1", "/p"), model: previousModel, thinkingLevel: "high" }],
			activeSessionId: "s1",
			currentModel: previousModel,
			thinkingLevel: "high",
		});
		piMock.setModel.mockRejectedValueOnce(new Error("no key"));
		await useSessionsStore.getState().setCurrentModel("anthropic", "sonnet");
		expect(useSessionsStore.getState().currentModel).toEqual(previousModel);
		expect(useSessionsStore.getState().thinkingLevel).toBe("high");
		expect(useSessionsStore.getState().sessions[0]?.model).toEqual(previousModel);
		expect(useSessionsStore.getState().sessions[0]?.thinkingLevel).toBe("high");
		expect(piMock.saveUiState).toHaveBeenLastCalledWith({
			currentModel: previousModel,
			thinkingLevel: "high",
		});
	});

	it("切思考深度失败：回滚（setThinkingLevel 路径同骨架）", async () => {
		useSessionsStore.setState({
			sessions: [{ ...realMeta("s1", "/p"), thinkingLevel: "low" }],
			activeSessionId: "s1",
			thinkingLevel: "low",
		});
		piMock.setThinkingLevel.mockRejectedValueOnce(new Error("boom"));
		await useSessionsStore.getState().setThinkingLevel("high");
		expect(useSessionsStore.getState().thinkingLevel).toBe("low");
		expect(useSessionsStore.getState().sessions[0]?.thinkingLevel).toBe("low");
	});
});

describe("permissionModes「缺 key = default」语义", () => {
	it("真实会话乐观置非 default，失败回滚到 default 时删 key", async () => {
		useSessionsStore.setState({ sessions: [realMeta("s1", "/p")], activeSessionId: "s1" });
		piMock.setPermissionMode.mockRejectedValueOnce(new Error("boom"));
		await useSessionsStore.getState().setSessionPermissionMode("s1", "fullAccess");
		expect(useSessionsStore.getState().permissionModes).toEqual({});
	});

	it("成功置 default = 显式删 key（不留 'default' 字面值）", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("s1", "/p")],
			activeSessionId: "s1",
			permissionModes: { s1: "fullAccess" },
		});
		await useSessionsStore.getState().setSessionPermissionMode("s1", "default");
		expect(useSessionsStore.getState().permissionModes).toEqual({});
		expect(piMock.setPermissionMode).toHaveBeenCalledWith("s1", "default");
	});

	it("draft 会话模式纯 renderer：不调 IPC", async () => {
		const draftId = `${DRAFT_SESSION_PREFIX}x`;
		useSessionsStore.setState({ sessions: [realMeta(draftId, "/p")], activeSessionId: draftId });
		await useSessionsStore.getState().setSessionPermissionMode(draftId, "fullAccess");
		expect(useSessionsStore.getState().permissionModes).toEqual({ [draftId]: "fullAccess" });
		expect(piMock.setPermissionMode).not.toHaveBeenCalled();
	});
});

describe("switchSession 懒加载兑底", () => {
	it("目标会话无 transcript 数据时补拉四件套；已有数据不重复拉取", async () => {
		useSessionsStore.setState({ sessions: [realMeta("s1", "/p"), realMeta("s2", "/p")], activeSessionId: "s2" });
		// s2 有数据（已有 entry）→ 切换不触发补拉
		useTranscriptStore.getState().setFollowUpQueue("s2", ["pending"]);
		piMock.getSessionMessages.mockClear();
		useSessionsStore.getState().switchSession("s2");
		await vi.waitFor(() => expect(useSessionsStore.getState().activeSessionId).toBe("s2"));
		expect(piMock.getSessionMessages).not.toHaveBeenCalled();

		// s1 无任何 entry → 切换触发补拉
		useSessionsStore.getState().switchSession("s1");
		await vi.waitFor(() => expect(piMock.getSessionMessages).toHaveBeenCalledWith("s1"));
		expect(useSessionsStore.getState().activeSessionId).toBe("s1");
	});
});
