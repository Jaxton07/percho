import type { SessionEvent, SessionMeta } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：sessions store 经 getPi() 访问，测试环境无 preload 注入 */
const piMock = vi.hoisted(() => ({
	createSession: vi.fn(),
	// 默认「后端同意关」；拒绝语义（agent 在跑）见 closeSession 的守卫用例
	closeSession: vi.fn(() => Promise.resolve({ closed: true })),
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

import {
	DRAFT_SESSION_PREFIX,
	isDraftSessionId,
	partitionSessionsByPin,
	selectBarSessions,
	useSessionsStore,
} from "./sessions";
import { useToastsStore } from "./toasts";
import { useTranscriptStore } from "./transcript";
import { useUiPreferencesStore } from "./ui-preferences";

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
		lastUsedModel: null,
		lastUsedThinkingLevel: "medium",
		trustVersion: 0,
		permissionModes: {},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// openSession 的 mockImplementation 是持久实现（clearAllMocks 不清），用例之间必须显式复位
	piMock.openSession.mockReset();
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

describe("partitionSessionsByPin", () => {
	const list = ["a", "b", "c", "d"].map((id) => realMeta(id, "/p"));
	const ids = (sessions: SessionMeta[]) => sessions.map((s) => s.sessionId);

	it("无置顶时原样返回（同一引用）", () => {
		expect(partitionSessionsByPin(list, [])).toBe(list);
	});

	it("置顶区在左，内部保持既有顺序（可拖动互换）", () => {
		expect(ids(partitionSessionsByPin(list, ["c", "a"]))).toEqual(["a", "c", "b", "d"]);
	});

	it("未知 id（会话已被外部删除）忽略，不生成空槽", () => {
		expect(ids(partitionSessionsByPin(list, ["ghost", "b"]))).toEqual(["b", "a", "c", "d"]);
		expect(partitionSessionsByPin(list, ["ghost"])).toBe(list);
	});
});

describe("selectBarSessions（顶栏 = 置顶表驱动）", () => {
	const tabs = [realMeta("a", "/p"), realMeta("b", "/p"), realMeta("c", "/p")];
	const history = [...tabs, realMeta("h1", "/p"), realMeta("h2", "/p")];
	const ids = (sessions: SessionMeta[]) => sessions.map((s) => s.sessionId);

	it("未置顶的已打开会话不进顶栏（顶栏不再是会话总表）", () => {
		expect(ids(selectBarSessions(tabs, [], history))).toEqual([]);
		expect(ids(selectBarSessions(tabs, ["c"], history))).toEqual(["c"]);
	});

	it("已置顶但 tab 未打开的会话仍要显示（meta 从历史找）—— 否则会出现「已置顶却不在顶栏」", () => {
		expect(ids(selectBarSessions(tabs, ["h2", "a"], history))).toEqual(["h2", "a"]);
	});

	it("顺序 = pinnedSessions 自己的顺序（新置顶在前，拖拽改的也是它）", () => {
		expect(ids(selectBarSessions(tabs, ["c", "a", "b"], history))).toEqual(["c", "a", "b"]);
	});

	it("同名会话以 tabs 实例为准（名称/状态取当前打开的那份）", () => {
		const renamed = { ...realMeta("a", "/p"), name: "新名字" };
		const out = selectBarSessions([renamed], ["a"], history);
		expect(out[0]?.name).toBe("新名字");
	});

	it("draft 不进顶栏：无置顶时即使存在 draft 也返回空（顶栏严格 = 置顶表）", () => {
		const draft = realMeta(`${DRAFT_SESSION_PREFIX}x`, "/p");
		expect(ids(selectBarSessions([...tabs, draft], [], history))).toEqual([]);
		expect(ids(selectBarSessions([...tabs, draft], ["c"], history))).toEqual(["c"]);
	});

	it("置顶表里的未知 id（会话已删）直接跳过，不生成空胶囊", () => {
		expect(ids(selectBarSessions(tabs, ["ghost", "b"], history))).toEqual(["b"]);
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
		expect(piMock.createSession).toHaveBeenCalledWith({
			options: { cwd: "/proj/b", thinkingLevel: "medium" },
		});
		expect(state.sessions).toHaveLength(2);
		expect(state.sessions[1]?.sessionId).toBe("real-1");
		expect(state.sessions[1]?.cwd).toBe("/proj/b");
		expect(state.activeSessionId).toBe("real-1");
		// v10：不再落盘打开列表（启动纯空，见 spec §12）
		expect(piMock.openSession).not.toHaveBeenCalled();
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
		expect(state.sessions).toHaveLength(0);
		expect(state.activeSessionId).toBeNull();
	});

	it("关闭真实会话：正常走后端并落盘", async () => {
		useSessionsStore.setState({ sessions: [realMeta("r1", "/proj/a")], activeSessionId: "r1" });
		await useSessionsStore.getState().closeSession("r1");
		expect(piMock.closeSession).toHaveBeenCalledWith({ sessionId: "r1" });
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

	it("后端拒绝（agent 在跑/等审批）→ 渲染层状态原样保留（事务语义，不留半个动作）", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("r1", "/proj/a")],
			activeSessionId: "r1",
			cwd: "/proj/a",
		});
		useTranscriptStore.getState().loadHistory("r1", []); // 造一个已装载的 transcript 条目
		piMock.closeSession.mockResolvedValueOnce({ closed: false });

		const result = await useSessionsStore.getState().closeSession("r1");

		expect(result).toEqual({ closed: false });
		const state = useSessionsStore.getState();
		expect(state.sessions.map((s) => s.sessionId)).toEqual(["r1"]); // 条目还在
		expect(state.activeSessionId).toBe("r1");
		// transcript 也没被清（不能出现「后端还活着、前端已消失」）
		expect(useTranscriptStore.getState().bySession.r1).toBeDefined();
	});

	it("后端异常（抛错）→ 同样保留状态并提示，不静默", async () => {
		useSessionsStore.setState({ sessions: [realMeta("r1", "/proj/a")], activeSessionId: "r1" });
		piMock.closeSession.mockRejectedValueOnce(new Error("boom"));
		const result = await useSessionsStore.getState().closeSession("r1");
		expect(result).toEqual({ closed: false });
		expect(useSessionsStore.getState().sessions.map((s) => s.sessionId)).toEqual(["r1"]);
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

		useSessionsStore.getState().switchSession(draftId);
		expect(useSessionsStore.getState().cwd).toBe("/proj/b");
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

	it("打开会话时用本机记住的档位盖过后端默认值（D7）", async () => {
		piMock.openSession.mockResolvedValue(realMeta("hist-2", "/proj"));
		piMock.getSessionMessages.mockResolvedValue([]);
		piMock.getPermissionMode.mockResolvedValue("default");
		useUiPreferencesStore.setState({ sessionPermissionModes: { "hist-2": "fullAccess" } });

		await useSessionsStore.getState().openFromHistory("/tmp/hist-2.jsonl");

		expect(piMock.setPermissionMode).toHaveBeenCalledWith({ sessionId: "hist-2", mode: "fullAccess" });
		expect(useSessionsStore.getState().permissionModes["hist-2"]).toBe("fullAccess");
	});

	it("没有记录时保持后端默认值（新会话/fork 不受影响）", async () => {
		piMock.openSession.mockResolvedValue(realMeta("hist-3", "/proj"));
		piMock.getSessionMessages.mockResolvedValue([]);
		piMock.getPermissionMode.mockResolvedValue("default");
		useUiPreferencesStore.setState({ sessionPermissionModes: {} });

		await useSessionsStore.getState().openFromHistory("/tmp/hist-3.jsonl");

		expect(piMock.setPermissionMode).not.toHaveBeenCalled();
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

describe("模型/思考级别", () => {
	it("draft 下切换模型：只记跟随值与 draft 条目，不调后端 setModel", async () => {
		useSessionsStore.getState().createDraftSession("/proj/a");
		await useSessionsStore.getState().setCurrentModel("p", "m");
		const state = useSessionsStore.getState();
		expect(piMock.setModel).not.toHaveBeenCalled();
		expect(state.lastUsedModel).toEqual({ provider: "p", modelId: "m" });
		expect(state.sessions[0]?.model).toEqual({ provider: "p", modelId: "m" });
		expect(piMock.saveUiState).toHaveBeenCalled();
	});
});

describe("乐观会话设置（optimisticSessionSetting 骨架）", () => {
	it("切模型成功：跟随值 + 会话条目乐观更新，ui-state 持久化", async () => {
		useSessionsStore.setState({
			models: [{ provider: "deepseek", providerName: "DeepSeek", id: "v4", label: "V4", authed: true }],
			sessions: [realMeta("s1", "/p")],
			activeSessionId: "s1",
		});
		await useSessionsStore.getState().setCurrentModel("deepseek", "v4");
		expect(piMock.setModel).toHaveBeenCalledWith({ sessionId: "s1", provider: "deepseek", modelId: "v4" });
		expect(useSessionsStore.getState().lastUsedModel).toEqual({ provider: "deepseek", modelId: "v4" });
		expect(useSessionsStore.getState().sessions[0]?.model).toEqual({ provider: "deepseek", modelId: "v4" });
		expect(piMock.saveUiState).toHaveBeenCalledWith({
			state: { lastUsedModel: { provider: "deepseek", modelId: "v4" }, lastUsedThinkingLevel: "medium" },
		});
	});

	it("切模型失败：跟随值 + 会话条目整体回滚，ui-state 以旧值重新持久化", async () => {
		const previousModel = { provider: "deepseek", modelId: "v4" };
		useSessionsStore.setState({
			models: [
				{ provider: "anthropic", providerName: "Anthropic", id: "sonnet", label: "Sonnet", authed: true },
			],
			sessions: [{ ...realMeta("s1", "/p"), model: previousModel, thinkingLevel: "high" }],
			activeSessionId: "s1",
			lastUsedModel: previousModel,
			lastUsedThinkingLevel: "high",
		});
		piMock.setModel.mockRejectedValueOnce(new Error("no key"));
		await useSessionsStore.getState().setCurrentModel("anthropic", "sonnet");
		expect(useSessionsStore.getState().lastUsedModel).toEqual(previousModel);
		expect(useSessionsStore.getState().lastUsedThinkingLevel).toBe("high");
		expect(useSessionsStore.getState().sessions[0]?.model).toEqual(previousModel);
		expect(useSessionsStore.getState().sessions[0]?.thinkingLevel).toBe("high");
		expect(piMock.saveUiState).toHaveBeenLastCalledWith({
			state: { lastUsedModel: previousModel, lastUsedThinkingLevel: "high" },
		});
	});

	it("切思考深度失败：回滚（setThinkingLevel 路径同骨架）", async () => {
		useSessionsStore.setState({
			sessions: [{ ...realMeta("s1", "/p"), thinkingLevel: "low" }],
			activeSessionId: "s1",
			lastUsedThinkingLevel: "low",
		});
		piMock.setThinkingLevel.mockRejectedValueOnce(new Error("boom"));
		await useSessionsStore.getState().setThinkingLevel("high");
		expect(useSessionsStore.getState().lastUsedThinkingLevel).toBe("low");
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
		expect(piMock.setPermissionMode).toHaveBeenCalledWith({ sessionId: "s1", mode: "default" });
	});

	it("成功置非 default → 记忆落盘（D7：按会话持久化）", async () => {
		useSessionsStore.setState({ sessions: [realMeta("s1", "/p")], activeSessionId: "s1" });
		await useSessionsStore.getState().setSessionPermissionMode("s1", "fullAccess");
		expect(piMock.saveUiState).toHaveBeenLastCalledWith({
			state: { sessionPermissionModes: { s1: "fullAccess" } },
		});
	});

	it("失败回滚时不记（D7：只记成功的档位）", async () => {
		useSessionsStore.setState({ sessions: [realMeta("s1", "/p")], activeSessionId: "s1" });
		useUiPreferencesStore.setState({ sessionPermissionModes: {} });
		piMock.setPermissionMode.mockRejectedValueOnce(new Error("boom"));
		await useSessionsStore.getState().setSessionPermissionMode("s1", "fullAccess");
		expect(useUiPreferencesStore.getState().sessionPermissionModes).toEqual({});
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
		useSessionsStore.setState({
			sessions: [realMeta("s1", "/p"), realMeta("s2", "/p")],
			activeSessionId: "s2",
		});
		// s2 有数据（已有 entry）→ 切换不触发补拉
		useTranscriptStore.getState().setFollowUpQueue("s2", ["pending"]);
		piMock.getSessionMessages.mockClear();
		useSessionsStore.getState().switchSession("s2");
		await vi.waitFor(() => expect(useSessionsStore.getState().activeSessionId).toBe("s2"));
		expect(piMock.getSessionMessages).not.toHaveBeenCalled();

		// s1 无任何 entry → 切换触发补拉
		useSessionsStore.getState().switchSession("s1");
		await vi.waitFor(() => expect(piMock.getSessionMessages).toHaveBeenCalledWith({ sessionId: "s1" }));
		expect(useSessionsStore.getState().activeSessionId).toBe("s1");
	});
});

describe("记住上次项目目录（lastCwd）", () => {
	// ui-preferences 是模块级单例，用例之间要显式清干净（store.setLastCwd 同值会短路，否则后续断言看不到写盘）
	beforeEach(() => useUiPreferencesStore.setState({ lastCwd: null }));

	it("从历史打开会话后记住该项目（重启启动页预填）", async () => {
		piMock.openSession.mockResolvedValue(realMeta("h1", "/work/alpha"));
		piMock.getSessionMessages.mockResolvedValue([]);
		await useSessionsStore.getState().openFromHistory("/work/alpha/s.jsonl");
		expect(useUiPreferencesStore.getState().lastCwd).toBe("/work/alpha");
		expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { lastCwd: "/work/alpha" } });
	});

	it("切会话后记住该会话的项目", () => {
		useSessionsStore.setState({
			sessions: [realMeta("a", "/work/alpha"), realMeta("b", "/work/beta")],
			activeSessionId: "a",
		});
		useSessionsStore.getState().switchSession("b");
		expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { lastCwd: "/work/beta" } });
	});

	it("新建会话（draft 转正）后记住该项目", async () => {
		piMock.createSession.mockResolvedValue(realMeta("real-1", "/work/gamma"));
		await useSessionsStore.getState().createSession("/work/gamma");
		expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { lastCwd: "/work/gamma" } });
	});

	it("在选择器里选项目（setDraftCwd）后立刻记住：首启选完项目没发消息就退出，下次也不用重选", () => {
		useSessionsStore.getState().createDraftSession("/work/alpha");
		piMock.saveUiState.mockClear();
		useSessionsStore.getState().setDraftCwd("/work/beta");
		expect(useUiPreferencesStore.getState().lastCwd).toBe("/work/beta");
		expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { lastCwd: "/work/beta" } });
	});

	it("同项目不重复写盘（避免切会话时刷 ui-state）", () => {
		useUiPreferencesStore.setState({ lastCwd: "/work/alpha" });
		useSessionsStore.setState({
			sessions: [realMeta("a", "/work/alpha"), realMeta("b", "/work/alpha")],
			activeSessionId: "a",
		});
		vi.clearAllMocks();
		useSessionsStore.getState().switchSession("b");
		expect(piMock.saveUiState).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// P0（spec channel-watch-retention-catchup §6.2）：自动卸载与用户关闭走不同 intent
// 阶段 0 红测：固定契约，实现见 plan 阶段 1.2。
// ---------------------------------------------------------------------------

describe("unloadSession（自动 GC）的 intent 标记", () => {
	it("自动卸载传 intent:'gc'（后端据此区分自动 GC 与用户意图，只对 GC 做订阅守卫）", async () => {
		useSessionsStore.setState({ sessions: [realMeta("r1", "/proj/a")], activeSessionId: null });

		await useSessionsStore.getState().unloadSession("r1");

		expect(piMock.closeSession).toHaveBeenCalledWith({ sessionId: "r1", intent: "gc" });
	});

	it("用户主动关闭不传 intent（保持既有语义：订阅不挡用户）", async () => {
		useSessionsStore.setState({ sessions: [realMeta("r2", "/proj/a")], activeSessionId: null });

		await useSessionsStore.getState().closeSession("r2");

		expect(piMock.closeSession).toHaveBeenCalledWith({ sessionId: "r2" });
	});
});

// ---------------------------------------------------------------------------
// 阶段 0 红测（spec sidebar-session-switch-stability D2/D3/D5、§5 导航 / GC）：
// ① 异步导航 latest-wins（旧 open/create/fork 迟到不得抢回 active）
// ② 同 sessionFile 的 open single-flight（同一文件同时只发一次 IPC、bundle 不并发重复）
// ③ GC close 在途时用户选中被卸载会话 → close 返回后 reopen 恢复，而不是把它抹掉
// 实现见 plan 阶段 2 / 3。
// ---------------------------------------------------------------------------

/** 手写 deferred：要精确控制「异步动作什么时候返回」，才能复现点击与响应的交错 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function toastKeys(): string[] {
	return useToastsStore
		.getState()
		.toasts.filter((t) => t.titleKey !== undefined)
		.map((t) => `${t.titleKey}`);
}

describe("导航 latest-wins：最后一次点击获胜（spec D2）", () => {
	beforeEach(() => useToastsStore.setState({ toasts: [] }));

	it("旧 open 迟到不得抢回 active：点击未加载 A → 切到已加载 B → A 才返回", async () => {
		const opened = deferred<SessionMeta>();
		piMock.openSession.mockImplementationOnce(() => opened.promise);
		useSessionsStore.setState({ sessions: [realMeta("b", "/p")], activeSessionId: "b", cwd: "/p" });

		const opening = useSessionsStore.getState().openFromHistory("/p/a.jsonl");
		useSessionsStore.getState().switchSession("b");
		opened.resolve(realMeta("a", "/p"));
		await opening;

		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBe("b");
		expect(state.cwd).toBe("/p");
		// 旧 open 成功仍可成为「已加载的后台会话」：latest-wins 只限制谁能激活
		expect(state.sessions.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
	});

	it("连续 open A / C：响应正序或逆序返回，最终都停在最后一次点击的 C", async () => {
		for (const order of ["a-then-c", "c-then-a"] as const) {
			resetStore();
			const a = deferred<SessionMeta>();
			const c = deferred<SessionMeta>();
			piMock.openSession.mockImplementation((args: { filePath: string }) =>
				args.filePath.includes("/a.jsonl") ? a.promise : c.promise,
			);

			const openingA = useSessionsStore.getState().openFromHistory("/p/a.jsonl");
			const openingC = useSessionsStore.getState().openFromHistory("/p/c.jsonl");
			if (order === "a-then-c") {
				a.resolve(realMeta("a", "/p"));
				await openingA;
				c.resolve(realMeta("c", "/p"));
				await openingC;
			} else {
				c.resolve(realMeta("c", "/p"));
				await openingC;
				a.resolve(realMeta("a", "/p"));
				await openingA;
			}

			expect(useSessionsStore.getState().activeSessionId).toBe("c");
		}
	});

	it("draft 转正（createSession）迟到不得覆盖后续 switch（新会话仍进 tabs）", async () => {
		const created = deferred<SessionMeta>();
		piMock.createSession.mockImplementationOnce(() => created.promise);
		useSessionsStore.getState().createDraftSession("/p");
		const draftId = useSessionsStore.getState().activeSessionId;
		if (!draftId) throw new Error("no draft");
		useSessionsStore.setState((state) => ({ sessions: [...state.sessions, realMeta("b", "/p")] }));

		const creating = useSessionsStore.getState().createSession("/p", draftId);
		useSessionsStore.getState().switchSession("b");
		created.resolve(realMeta("new-1", "/p"));
		const createdId = await creating;

		// 迟到的创建仍要把新会话 id 交给调用方（发送方按返回值定位，不读 active）
		expect(createdId).toBe("new-1");
		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBe("b");
		expect(state.cwd).toBe("/p");
		expect(state.sessions.map((s) => s.sessionId)).toContain("new-1");
	});

	it("createSession 失败返回 null（调用方据此中止发送），且不动 active/cwd", async () => {
		piMock.createSession.mockRejectedValueOnce(new Error("create boom"));
		useSessionsStore.setState({ sessions: [realMeta("b", "/p")], activeSessionId: "b", cwd: "/p" });

		expect(await useSessionsStore.getState().createSession("/p")).toBeNull();

		expect(useSessionsStore.getState().activeSessionId).toBe("b");
		expect(useSessionsStore.getState().cwd).toBe("/p");
		expect(toastKeys()).toContain("toast.sessionCreateFailed");
	});

	it("fork 迟到不得覆盖后续 switch（新会话进 tabs，但不抢 active）", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("r1", "/p"), realMeta("r2", "/p")],
			activeSessionId: "r1",
			cwd: "/p",
		});
		const forked = deferred<SessionMeta>();
		piMock.forkSession.mockImplementationOnce(() => forked.promise);

		const forking = useSessionsStore.getState().forkSession({ entryId: "e1" });
		useSessionsStore.getState().switchSession("r2");
		forked.resolve(realMeta("f1", "/p"));

		// fork 事实上发生了：仍要返回新 id 供调用方使用
		expect(await forking).toBe("f1");
		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBe("r2");
		expect(state.sessions.map((s) => s.sessionId)).toContain("f1");
	});

	it("旧 open 失败不得回滚用户的新选择（新选择仍在，且只提示一次）", async () => {
		const opened = deferred<SessionMeta>();
		piMock.openSession.mockImplementationOnce(() => opened.promise);
		useSessionsStore.setState({ sessions: [realMeta("b", "/p")], activeSessionId: "b", cwd: "/p" });

		const opening = useSessionsStore.getState().openFromHistory("/p/a.jsonl");
		useSessionsStore.getState().switchSession("b");
		opened.reject(new Error("open boom"));
		await opening;

		expect(useSessionsStore.getState().activeSessionId).toBe("b");
		expect(useSessionsStore.getState().cwd).toBe("/p");
	});
});

describe("同 sessionFile 的 open single-flight（spec D3）", () => {
	beforeEach(() => useToastsStore.setState({ toasts: [] }));

	it("同一文件双击：只发一次 IPC，bundle 不并发重复装载，最终 active = 该会话", async () => {
		const opened = deferred<SessionMeta>();
		piMock.openSession.mockImplementation(() => opened.promise);

		const first = useSessionsStore.getState().openFromHistory("/p/a.jsonl");
		const second = useSessionsStore.getState().openFromHistory("/p/a.jsonl");
		expect(piMock.openSession).toHaveBeenCalledTimes(1);
		opened.resolve(realMeta("a", "/p"));
		await Promise.all([first, second]);

		expect(useSessionsStore.getState().activeSessionId).toBe("a");
		expect(piMock.getSessionMessages).toHaveBeenCalledTimes(1);
		expect(useSessionsStore.getState().sessions.filter((s) => s.sessionId === "a")).toHaveLength(1);
	});

	it("共享请求失败只 toast 一次（不因调用者数量重复刷屏），且 in-flight 清空可重试", async () => {
		const opened = deferred<SessionMeta>();
		piMock.openSession
			.mockImplementationOnce(() => opened.promise)
			.mockImplementationOnce(() => Promise.resolve(realMeta("a", "/p")));

		const failing = useSessionsStore.getState().openFromHistory("/p/a.jsonl");
		const failingToo = useSessionsStore.getState().openFromHistory("/p/a.jsonl");
		opened.reject(new Error("boom"));
		await Promise.all([failing, failingToo]);

		expect(toastKeys().filter((key) => key === "toast.sessionOpenFailed")).toHaveLength(1);
		expect(useSessionsStore.getState().activeSessionId).toBeNull();

		// settle 后 key 已清：再次点击会重新 open
		await useSessionsStore.getState().openFromHistory("/p/a.jsonl");
		expect(piMock.openSession).toHaveBeenCalledTimes(2);
		expect(useSessionsStore.getState().activeSessionId).toBe("a");
	});

	it("不同文件并发 open 各自独立（single-flight 只按文件去重）", async () => {
		piMock.openSession.mockImplementation((args: { filePath: string }) =>
			Promise.resolve(realMeta(args.filePath.includes("/a.jsonl") ? "a" : "c", "/p")),
		);

		await Promise.all([
			useSessionsStore.getState().openFromHistory("/p/a.jsonl"),
			useSessionsStore.getState().openFromHistory("/p/c.jsonl"),
		]);

		expect(piMock.openSession).toHaveBeenCalledTimes(2);
		expect(
			useSessionsStore
				.getState()
				.sessions.map((s) => s.sessionId)
				.sort(),
		).toEqual(["a", "c"]);
	});
});

describe("GC close 在途的选择竞态（spec D5）", () => {
	beforeEach(() => useToastsStore.setState({ toasts: [] }));

	it("close 在途期间用户切到该会话：关闭成功后自动 reopen，保留 transcript/active，返回 closed:false", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("a", "/p"), realMeta("b", "/p")],
			activeSessionId: "a",
			cwd: "/p",
		});
		// transcript 侧标记：reopen 恢复不能 reset 已有数据
		useTranscriptStore.getState().setFollowUpQueue("b", ["kept"]);
		const closing = deferred<{ closed: boolean }>();
		piMock.closeSession.mockImplementationOnce(() => closing.promise);
		piMock.openSession.mockResolvedValueOnce(realMeta("b", "/p"));

		const unloading = useSessionsStore.getState().unloadSession("b");
		useSessionsStore.getState().switchSession("b");
		closing.resolve({ closed: true });
		const result = await unloading;

		// 后端已关又重建 → GC 这一轮视为「没卸成」，而不是让 renderer 删掉用户刚选的会话
		expect(result).toEqual({ closed: false });
		expect(piMock.openSession).toHaveBeenCalledWith({ filePath: "/tmp/b.jsonl" });
		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBe("b");
		expect(state.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
		expect(useTranscriptStore.getState().bySession.b?.followUpQueue).toEqual(["kept"]);
	});

	it("close 在途期间用户切到别处：正常卸载（closed:true、条目移除，不 reopen）", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("a", "/p"), realMeta("b", "/p")],
			activeSessionId: "a",
			cwd: "/p",
		});
		const closing = deferred<{ closed: boolean }>();
		piMock.closeSession.mockImplementationOnce(() => closing.promise);

		const unloading = useSessionsStore.getState().unloadSession("b");
		useSessionsStore.getState().switchSession("a");
		closing.resolve({ closed: true });

		expect(await unloading).toEqual({ closed: true });
		expect(piMock.openSession).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().sessions.map((s) => s.sessionId)).toEqual(["a"]);
	});

	it("reopen 成功后把 renderer 持有的权限档位拉回新 backend 会话（重开一律 default 起步）", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("a", "/p"), realMeta("b", "/p")],
			activeSessionId: "a",
			cwd: "/p",
			permissionModes: { b: "fullAccess" },
		});
		const closing = deferred<{ closed: boolean }>();
		piMock.closeSession.mockImplementationOnce(() => closing.promise);
		piMock.openSession.mockResolvedValueOnce(realMeta("b", "/p"));
		// b 已有 transcript（真实场景：它是被 GC 判定可卸的已打开会话）→ 切换不触发懒加载
		useTranscriptStore.getState().setFollowUpQueue("b", ["kept"]);

		const unloading = useSessionsStore.getState().unloadSession("b");
		useSessionsStore.getState().switchSession("b");
		closing.resolve({ closed: true });
		const result = await unloading;

		expect(result).toEqual({ closed: false });
		expect(piMock.setPermissionMode).toHaveBeenCalledWith({ sessionId: "b", mode: "fullAccess" });
		expect(useSessionsStore.getState().permissionModes.b).toBe("fullAccess");
	});

	it("reopen 成功后权限档位恢复失败：返回 closed:false，但 renderer 回落 default（不能显示后端没执行的档位）", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("a", "/p"), realMeta("b", "/p")],
			activeSessionId: "a",
			cwd: "/p",
			permissionModes: { b: "fullAccess" },
		});
		const closing = deferred<{ closed: boolean }>();
		piMock.closeSession.mockImplementationOnce(() => closing.promise);
		piMock.openSession.mockResolvedValueOnce(realMeta("b", "/p"));
		piMock.setPermissionMode.mockRejectedValueOnce(new Error("mode boom"));
		useTranscriptStore.getState().setFollowUpQueue("b", ["kept"]);

		const unloading = useSessionsStore.getState().unloadSession("b");
		useSessionsStore.getState().switchSession("b");
		closing.resolve({ closed: true });
		const result = await unloading;

		// 后端会话已重建成功 → GC 仍视为没卸成；但不能因此把后端真值（default）藏在 UI 后面
		expect(result).toEqual({ closed: false });
		expect(useSessionsStore.getState().permissionModes.b).toBeUndefined();
		expect(toastKeys()).toContain("toast.permissionModeFailed");
		expect(useSessionsStore.getState().sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
	});

	it("reopen 失败：不留幽灵 active（按正常关闭清理并显形提示）", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("a", "/p"), realMeta("b", "/p")],
			activeSessionId: "a",
			cwd: "/p",
		});
		const closing = deferred<{ closed: boolean }>();
		piMock.closeSession.mockImplementationOnce(() => closing.promise);
		piMock.openSession.mockRejectedValueOnce(new Error("reopen boom"));

		const unloading = useSessionsStore.getState().unloadSession("b");
		useSessionsStore.getState().switchSession("b");
		closing.resolve({ closed: true });
		const result = await unloading;

		expect(result).toEqual({ closed: true });
		const state = useSessionsStore.getState();
		expect(state.sessions.map((s) => s.sessionId)).toEqual(["a"]);
		expect(state.activeSessionId).toBe("a");
		expect(toastKeys()).toContain("toast.sessionOpenFailed");
	});

	it("reopen 在途期间用户又切走：不得抢回 active（恢复不是新的用户导航）", async () => {
		useSessionsStore.setState({
			sessions: [realMeta("a", "/p"), realMeta("b", "/p"), realMeta("c", "/p")],
			activeSessionId: "a",
			cwd: "/p",
		});
		const closing = deferred<{ closed: boolean }>();
		const reopening = deferred<SessionMeta>();
		piMock.closeSession.mockImplementationOnce(() => closing.promise);
		piMock.openSession.mockImplementationOnce(() => reopening.promise);

		const unloading = useSessionsStore.getState().unloadSession("b");
		useSessionsStore.getState().switchSession("b");
		closing.resolve({ closed: true });
		await vi.waitFor(() => expect(piMock.openSession).toHaveBeenCalledTimes(1));
		useSessionsStore.getState().switchSession("c");
		reopening.resolve(realMeta("b", "/p"));

		expect(await unloading).toEqual({ closed: false });
		expect(useSessionsStore.getState().activeSessionId).toBe("c");
	});
});
