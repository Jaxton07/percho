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
	// loadModels 的输入（阶段 0 的 draft 默认模型补齐用例）：无类型 mock，用例内 mockImplementation 喂数据
	listModels: vi.fn(),
	loadUiState: vi.fn(),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { NEW_SESSION_DRAFT_KEY, useDraftStore } from "./drafts";
import { partitionSessionsByPin, selectBarSessions, useSessionsStore } from "./sessions";
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
	useSessionsStore.setState({ newSessionDraft: null });
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
	useDraftStore.setState({ bySession: {} });
}

beforeEach(() => {
	vi.clearAllMocks();
	// openSession 的 mockImplementation 是持久实现（clearAllMocks 不清），用例之间必须显式复位
	piMock.openSession.mockReset();
	resetStore();
	useTranscriptStore.setState({ bySession: {} });
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

	it("未置顶的已打开会话不进顶栏：顶栏严格 = 置顶表（新会话 draft 根本不在 sessions）", () => {
		const fresh = realMeta("fresh-1", "/p");
		expect(ids(selectBarSessions([...tabs, fresh], [], history))).toEqual([]);
		expect(ids(selectBarSessions([...tabs, fresh], ["c"], history))).toEqual(["c"]);
	});

	it("置顶表里的未知 id（会话已删）直接跳过，不生成空胶囊", () => {
		expect(ids(selectBarSessions(tabs, ["ghost", "b"], history))).toEqual(["b"]);
	});

	// 阶段 0 红测（spec §6.3）：tmp subagent 检视会话不该出现在顶栏。
	it("只读子会话（脏置顶 / 手改 ui-state）被防御性过滤，不生成只读胶囊", () => {
		const sub = { ...realMeta("sub-1", "/p"), readOnly: true };
		expect(ids(selectBarSessions([sub], ["sub-1"], [sub]))).toEqual([]);
	});
});

describe("closeSession", () => {
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
	it("切到真实会话：cwd 跟随该会话的项目", () => {
		useSessionsStore.setState({
			sessions: [realMeta("r1", "/proj/a")],
			activeSessionId: "r1",
			cwd: "/proj/a",
		});
		useSessionsStore.getState().switchSession("r1");
		expect(useSessionsStore.getState().cwd).toBe("/proj/a");
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

	it("首条消息 promotion 成功后记住该项目", async () => {
		piMock.createSession.mockResolvedValue(realMeta("new-1", "/work/gamma"));
		useSessionsStore.getState().activateNewSessionDraft("/work/gamma");
		await useSessionsStore.getState().createSession();
		expect(useUiPreferencesStore.getState().lastCwd).toBe("/work/gamma");
		expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { lastCwd: "/work/gamma" } });
	});

	it("在选择器里选项目（setDraftCwd）后立刻记住：首启选完项目没发消息就退出，下次也不用重选", () => {
		useSessionsStore.getState().activateNewSessionDraft("/work/alpha");
		piMock.saveUiState.mockClear();
		useSessionsStore.getState().setDraftCwd("/work/beta");
		expect(useSessionsStore.getState().newSessionDraft?.cwd).toBe("/work/beta");
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

	it("无 draft 时 createSession 返回 null（调用方据此中止发送），不发 IPC、不动 active/cwd", async () => {
		useSessionsStore.setState({ sessions: [realMeta("b", "/p")], activeSessionId: "b", cwd: "/p" });

		expect(await useSessionsStore.getState().createSession()).toBeNull();

		expect(piMock.createSession).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().activeSessionId).toBe("b");
		expect(useSessionsStore.getState().cwd).toBe("/p");
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

// ---------------------------------------------------------------------------
// 阶段 0/1 契约（spec singleton-draft-subagent-nav §5）：
// ① 新会话 = renderer 全局唯一 draft（`activeSessionId === null`），不再有伪 SessionMeta 占位条目；
// ② 点击「＋」最多激活/创建一个 draft，已有 draft 必须保留内容与配置；
// ③ 首条消息 promotion：吃 draft 入口快照 + single-flight + latest-wins + 失败保留。
// ---------------------------------------------------------------------------

describe("单例新会话 draft（newSessionDraft）", () => {
	it("activateNewSessionDraft 不往 sessions 加条目：draft 只是 renderer 编辑态", () => {
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().activateNewSessionDraft();
		const state = useSessionsStore.getState();
		expect(state.sessions).toEqual([]);
		expect(state.activeSessionId).toBeNull();
		expect(state.newSessionDraft?.cwd).toBe("/proj/a");
		expect(state.newSessionDraft?.permissionMode).toBe("default");
		expect(piMock.createSession).not.toHaveBeenCalled();
	});

	it("激活 draft 即前置项目信任决策（结果落 trust.json，斜杠命令/需求转正直接命中缓存）", () => {
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().activateNewSessionDraft();
		expect(piMock.ensureProjectTrust).toHaveBeenCalledWith({ cwd: "/proj/a" });
	});

	it("从当前真实会话快照 cwd/model/thinking（全局最近值是另一套，不得采用）", () => {
		useSessionsStore.setState({
			sessions: [
				{ ...realMeta("a", "/proj/alpha"), model: { provider: "pA", modelId: "mA" }, thinkingLevel: "high" },
			],
			activeSessionId: "a",
			cwd: "/proj/alpha",
			lastUsedModel: { provider: "pB", modelId: "mB" },
			lastUsedThinkingLevel: "low",
		});
		useSessionsStore.getState().activateNewSessionDraft();
		const draft = useSessionsStore.getState().newSessionDraft;
		expect(draft?.cwd).toBe("/proj/alpha");
		expect(draft?.model).toEqual({ provider: "pA", modelId: "mA" });
		expect(draft?.thinkingLevel).toBe("high");
	});

	it("已在 draft 时再点「＋」：返回同一 draft，配置与输入内容都不覆盖（离开 → 真实 switchSession → 回来）", () => {
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().activateNewSessionDraft();
		useSessionsStore.getState().setDraftCwd("/proj/b");
		useSessionsStore.getState().setDraftPermissionMode("fullAccess");
		useDraftStore.getState().updateDraft(NEW_SESSION_DRAFT_KEY, (d) => ({ ...d, text: "半包需求" }));
		// 用户切到真实会话（真实动作，不用裸 setState 绕开要验证的路径）
		useSessionsStore.setState({
			sessions: [realMeta("r1", "/proj/a")],
			activeSessionId: "r1",
			cwd: "/proj/a",
		});
		useSessionsStore.getState().switchSession("r1");

		useSessionsStore.getState().activateNewSessionDraft();

		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBeNull();
		expect(state.newSessionDraft?.cwd).toBe("/proj/b");
		expect(state.newSessionDraft?.permissionMode).toBe("fullAccess");
		expect(state.cwd).toBe("/proj/b");
		expect(state.sessions.map((s) => s.sessionId)).toEqual(["r1"]);
		expect(useDraftStore.getState().bySession[NEW_SESSION_DRAFT_KEY]?.text).toBe("半包需求");
	});

	it("draft 输入内容（文字/图片/slash/引用）挂在全局新会话草稿键上，再次激活不重置", () => {
		useSessionsStore.setState({ cwd: "/proj/a" });
		const draftStore = useDraftStore.getState();
		draftStore.updateDraft(NEW_SESSION_DRAFT_KEY, () => ({
			text: "接着上一句",
			images: [{ data: "AAAA", mimeType: "image/png" }],
			slashCommand: "compact",
			attachments: ["src/a.ts"],
			quotes: ["引用段落"],
		}));

		useSessionsStore.getState().activateNewSessionDraft();
		expect(useDraftStore.getState().bySession[NEW_SESSION_DRAFT_KEY]).toEqual({
			text: "接着上一句",
			images: [{ data: "AAAA", mimeType: "image/png" }],
			slashCommand: "compact",
			attachments: ["src/a.ts"],
			quotes: ["引用段落"],
		});

		useSessionsStore.getState().activateNewSessionDraft();
		expect(useDraftStore.getState().bySession[NEW_SESSION_DRAFT_KEY]?.text).toBe("接着上一句");
	});

	it("无 cwd 也能进入 draft（newSessionDraft.cwd === null，不静默 no-op）", () => {
		useSessionsStore.getState().activateNewSessionDraft();
		expect(useSessionsStore.getState().newSessionDraft?.cwd).toBeNull();
		expect(useSessionsStore.getState().activeSessionId).toBeNull();
	});

	it("draft 权限模式写在 draft 配置里：不占 permissionModes map、不调 IPC", () => {
		useSessionsStore.getState().activateNewSessionDraft();
		useSessionsStore.getState().setDraftPermissionMode("fullAccess");
		expect(useSessionsStore.getState().newSessionDraft?.permissionMode).toBe("fullAccess");
		expect(useSessionsStore.getState().permissionModes).toEqual({});
		expect(piMock.setPermissionMode).not.toHaveBeenCalled();
	});

	it("真实会话里改模型/思考：不得覆盖后台那份 draft 快照（单例 draft 跨会话存活）", async () => {
		// 先在 draft 页配好一套
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().activateNewSessionDraft();
		useSessionsStore.getState().setDraftCwd("/proj/b");
		await useSessionsStore.getState().setCurrentModel("pDraft", "mDraft");
		await useSessionsStore.getState().setThinkingLevel("low");
		const before = useSessionsStore.getState().newSessionDraft;
		expect(before?.cwd).toBe("/proj/b");

		// 切到真实会话，在那里改模型/思考
		useSessionsStore.setState({
			sessions: [
				{ ...realMeta("r1", "/proj/a"), model: { provider: "p1", modelId: "m1" }, thinkingLevel: "medium" },
			],
			activeSessionId: "r1",
			cwd: "/proj/a",
		});
		await useSessionsStore.getState().setCurrentModel("p2", "m2");
		await useSessionsStore.getState().setThinkingLevel("high");

		expect(useSessionsStore.getState().sessions[0]?.model).toEqual({ provider: "p2", modelId: "m2" });
		expect(useSessionsStore.getState().sessions[0]?.thinkingLevel).toBe("high");
		expect(useSessionsStore.getState().newSessionDraft).toEqual(before);
	});

	it("冷启动：无会话快照时 thinking 不算「已定」，loadModels 用持久化偏好回填（占位 medium 不得锁死）", async () => {
		piMock.listModels.mockImplementation(() =>
			Promise.resolve([
				{
					provider: "deepseek",
					providerName: "DeepSeek",
					id: "v4",
					label: "V4",
					authed: true,
					thinkingLevels: ["low", "medium", "high"],
				},
			]),
		);
		piMock.loadUiState.mockImplementation(() =>
			Promise.resolve({
				lastUsedModel: { provider: "deepseek", modelId: "v4" },
				lastUsedThinkingLevel: "high",
			}),
		);
		// 冷启动：模型列表还没回来，lastUsedThinkingLevel 只是占位 medium
		useSessionsStore.setState({ lastUsedThinkingLevel: "medium" });
		useSessionsStore.getState().activateNewSessionDraft();
		expect(useSessionsStore.getState().newSessionDraft?.thinkingLevel).toBe("medium");

		await useSessionsStore.getState().loadModels();

		const draft = useSessionsStore.getState().newSessionDraft;
		expect(draft?.thinkingLevel).toBe("high");
		expect(draft?.model).toEqual({ provider: "deepseek", modelId: "v4" });
	});

	it("开机的空 draft（cwd === null）→ 先打开真实会话 → 点「＋」：继承当前会话项目，不空着", () => {
		// 开机那份：没有 lastCwd，cwd 为空
		useSessionsStore.setState({ cwd: null });
		useSessionsStore.getState().activateNewSessionDraft();
		expect(useSessionsStore.getState().newSessionDraft?.cwd).toBeNull();

		// 用户先从历史打开一个真实会话
		useSessionsStore.setState({
			sessions: [realMeta("h1", "/proj/from-history")],
			activeSessionId: "h1",
			cwd: "/proj/from-history",
		});
		useSessionsStore.getState().switchSession("h1");

		useSessionsStore.getState().activateNewSessionDraft();

		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBeNull();
		expect(state.newSessionDraft?.cwd).toBe("/proj/from-history");
		expect(state.cwd).toBe("/proj/from-history");
		expect(piMock.ensureProjectTrust).toHaveBeenCalledWith({ cwd: "/proj/from-history" });
	});

	it("未选项目的 draft（cwd === null）接受「＋」/启动传进来的起点 cwd，已选的仍不覆盖", () => {
		useSessionsStore.setState({ cwd: null });
		useSessionsStore.getState().activateNewSessionDraft();
		expect(useSessionsStore.getState().newSessionDraft?.cwd).toBeNull();

		// 初始化/补种出来的 draft 还没选项目：接受起点（App 启动种 lastCwd 走的就是这条）
		useSessionsStore.getState().activateNewSessionDraft("/proj/fromLastCwd");
		expect(useSessionsStore.getState().newSessionDraft?.cwd).toBe("/proj/fromLastCwd");
		expect(piMock.ensureProjectTrust).toHaveBeenCalledWith({ cwd: "/proj/fromLastCwd" });

		// 已经选过的目录不被冲掉
		useSessionsStore.getState().activateNewSessionDraft("/proj/other");
		expect(useSessionsStore.getState().newSessionDraft?.cwd).toBe("/proj/fromLastCwd");
	});

	it("draft 态切换模型/思考深度：只改 draft 配置与最近使用偏好，不调后端", async () => {
		useSessionsStore.getState().activateNewSessionDraft();
		await useSessionsStore.getState().setCurrentModel("p", "m");
		await useSessionsStore.getState().setThinkingLevel("high");
		expect(piMock.setModel).not.toHaveBeenCalled();
		expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().newSessionDraft?.model).toEqual({ provider: "p", modelId: "m" });
		expect(useSessionsStore.getState().newSessionDraft?.thinkingLevel).toBe("high");
		expect(useSessionsStore.getState().lastUsedModel).toEqual({ provider: "p", modelId: "m" });
		expect(useSessionsStore.getState().lastUsedThinkingLevel).toBe("high");
	});

	it("初始 draft 无可继承模型：loadModels 补最近（或首个可用）模型", async () => {
		piMock.listModels.mockImplementation(() =>
			Promise.resolve([
				{ provider: "deepseek", providerName: "DeepSeek", id: "v4", label: "V4", authed: true },
			]),
		);
		piMock.loadUiState.mockImplementation(() =>
			Promise.resolve({ lastUsedModel: { provider: "deepseek", modelId: "v4" } }),
		);

		useSessionsStore.getState().activateNewSessionDraft();
		expect(useSessionsStore.getState().newSessionDraft?.model).toBeNull();

		await useSessionsStore.getState().loadModels();

		expect(useSessionsStore.getState().newSessionDraft?.model).toEqual({
			provider: "deepseek",
			modelId: "v4",
		});
	});

	it("draft 已从当前会话继承模型：loadModels 不得改成「全局最近」那一个", async () => {
		// A = 当前会话的模型（draft 继承它），B = 全局最近值；两个都是列表里的合法模型，
		// 这样才只验证「快照优先于全局最近」，不搅进「失效模型回退」语义。
		piMock.listModels.mockImplementation(() =>
			Promise.resolve([
				{ provider: "pA", providerName: "ProviderA", id: "mA", label: "Model A", authed: true },
				{ provider: "deepseek", providerName: "DeepSeek", id: "v4", label: "V4", authed: true },
			]),
		);
		piMock.loadUiState.mockImplementation(() =>
			Promise.resolve({ lastUsedModel: { provider: "deepseek", modelId: "v4" } }),
		);
		useSessionsStore.setState({
			sessions: [
				{ ...realMeta("a", "/proj/a"), model: { provider: "pA", modelId: "mA" }, thinkingLevel: "high" },
			],
			activeSessionId: "a",
			cwd: "/proj/a",
		});

		useSessionsStore.getState().activateNewSessionDraft();
		await useSessionsStore.getState().loadModels();

		expect(useSessionsStore.getState().newSessionDraft?.model).toEqual({ provider: "pA", modelId: "mA" });
	});

	it("用户已在 draft 上改过思考档位：loadModels 仍补空模型，但不得覆盖该档位", async () => {
		piMock.listModels.mockImplementation(() =>
			Promise.resolve([
				{
					provider: "deepseek",
					providerName: "DeepSeek",
					id: "v4",
					label: "V4",
					authed: true,
					thinkingLevels: ["low", "medium", "high"],
				},
			]),
		);
		piMock.loadUiState.mockImplementation(() =>
			Promise.resolve({
				lastUsedModel: { provider: "deepseek", modelId: "v4" },
				lastUsedThinkingLevel: "low",
			}),
		);

		useSessionsStore.getState().activateNewSessionDraft();
		await useSessionsStore.getState().setThinkingLevel("high");

		await useSessionsStore.getState().loadModels();

		// dirty 必须分字段：改过思考不等于改过模型——模型仍要按默认补齐，思考选择不被回写
		expect(useSessionsStore.getState().newSessionDraft?.model).toEqual({
			provider: "deepseek",
			modelId: "v4",
		});
		expect(useSessionsStore.getState().newSessionDraft?.thinkingLevel).toBe("high");
	});
});

describe("promotion：首条消息把 draft 转成真实会话", () => {
	beforeEach(() => useToastsStore.setState({ toasts: [] }));

	it("用 draft 快照创建：当前会话模型 A 优先于全局最近 B", async () => {
		piMock.createSession.mockResolvedValue(realMeta("new-1", "/proj/alpha"));
		useSessionsStore.setState({
			sessions: [
				{ ...realMeta("a", "/proj/alpha"), model: { provider: "pA", modelId: "mA" }, thinkingLevel: "high" },
			],
			activeSessionId: "a",
			cwd: "/proj/alpha",
			lastUsedModel: { provider: "pB", modelId: "mB" },
			lastUsedThinkingLevel: "low",
		});
		useSessionsStore.getState().activateNewSessionDraft();

		expect(await useSessionsStore.getState().createSession()).toBe("new-1");

		expect(piMock.createSession).toHaveBeenCalledTimes(1);
		expect(piMock.createSession).toHaveBeenCalledWith({
			options: { cwd: "/proj/alpha", provider: "pA", modelId: "mA", thinkingLevel: "high" },
		});
		const state = useSessionsStore.getState();
		expect(state.newSessionDraft).toBeNull();
		expect(state.sessions.map((s) => s.sessionId)).toEqual(["a", "new-1"]);
		expect(state.activeSessionId).toBe("new-1");
		expect(state.cwd).toBe("/proj/alpha");
	});

	it("并发两次（发送 + 命令）共享一次 pi.createSession，返回同一个 id", async () => {
		const created = deferred<SessionMeta>();
		piMock.createSession.mockImplementationOnce(() => created.promise);
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().activateNewSessionDraft();

		const first = useSessionsStore.getState().createSession();
		const second = useSessionsStore.getState().createSession();
		expect(piMock.createSession).toHaveBeenCalledTimes(1);
		created.resolve(realMeta("new-1", "/proj/a"));

		expect(await first).toBe("new-1");
		expect(await second).toBe("new-1");
		expect(useSessionsStore.getState().sessions.filter((s) => s.sessionId === "new-1")).toHaveLength(1);
	});

	it("创建失败：draft 与配置、输入内容完整保留，重试会重新发 IPC", async () => {
		piMock.createSession
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(realMeta("new-1", "/proj/a"));
		useSessionsStore.getState().activateNewSessionDraft("/proj/a");
		useSessionsStore.getState().setDraftPermissionMode("fullAccess");
		useDraftStore.getState().updateDraft(NEW_SESSION_DRAFT_KEY, (d) => ({ ...d, text: "别丢了我" }));

		expect(await useSessionsStore.getState().createSession()).toBeNull();

		const afterFail = useSessionsStore.getState();
		expect(afterFail.newSessionDraft?.cwd).toBe("/proj/a");
		expect(afterFail.newSessionDraft?.permissionMode).toBe("fullAccess");
		expect(afterFail.activeSessionId).toBeNull();
		expect(useDraftStore.getState().bySession[NEW_SESSION_DRAFT_KEY]?.text).toBe("别丢了我");
		expect(toastKeys()).toContain("toast.sessionCreateFailed");

		expect(await useSessionsStore.getState().createSession()).toBe("new-1");
		expect(piMock.createSession).toHaveBeenCalledTimes(2);
	});

	it("创建在途时用户切走：真实 meta 仍进 sessions 且 draft 被消费，但不抢 active/cwd", async () => {
		const created = deferred<SessionMeta>();
		piMock.createSession.mockImplementationOnce(() => created.promise);
		useSessionsStore.setState({ sessions: [realMeta("b", "/proj/b")], activeSessionId: "b", cwd: "/proj/b" });
		useSessionsStore.getState().activateNewSessionDraft("/proj/a");

		const promoting = useSessionsStore.getState().createSession();
		useSessionsStore.getState().switchSession("b");
		created.resolve(realMeta("new-1", "/proj/a"));

		expect(await promoting).toBe("new-1");
		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBe("b");
		expect(state.cwd).toBe("/proj/b");
		expect(state.sessions.map((s) => s.sessionId)).toContain("new-1");
		expect(state.newSessionDraft).toBeNull();
	});

	it("draft 非 default 权限模式：创建成功后应用到新会话", async () => {
		piMock.createSession.mockResolvedValue(realMeta("new-1", "/proj/a"));
		useSessionsStore.getState().activateNewSessionDraft("/proj/a");
		useSessionsStore.getState().setDraftPermissionMode("fullAccess");

		await useSessionsStore.getState().createSession();

		expect(piMock.setPermissionMode).toHaveBeenCalledWith({ sessionId: "new-1", mode: "fullAccess" });
		expect(useSessionsStore.getState().permissionModes["new-1"]).toBe("fullAccess");
	});

	it("draft.cwd === null：返回 null 且不发 IPC（等用户在项目选择器里选目录）", async () => {
		useSessionsStore.getState().activateNewSessionDraft();

		expect(await useSessionsStore.getState().createSession()).toBeNull();

		expect(piMock.createSession).not.toHaveBeenCalled();
		expect(useSessionsStore.getState().newSessionDraft?.cwd).toBeNull();
		expect(useSessionsStore.getState().activeSessionId).toBeNull();
	});

	it("D1 已消费、还在等权限 IPC 时新建 D2：D2 必须另发一次 create 并返回 D2 的 id", async () => {
		const first = deferred<SessionMeta>();
		const second = deferred<SessionMeta>();
		const permission = deferred<void>();
		piMock.createSession
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise);
		piMock.setPermissionMode.mockImplementationOnce(() => permission.promise);

		// D1：选 fullAccess，好让 promotion 在 meta 落地后还卡在权限 IPC 上
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().activateNewSessionDraft("/proj/a");
		useSessionsStore.getState().setDraftPermissionMode("fullAccess");
		const promoting1 = useSessionsStore.getState().createSession();

		first.resolve(realMeta("new-1", "/proj/a"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(useSessionsStore.getState().newSessionDraft).toBeNull(); // D1 已消费，仍卡在权限 IPC

		// 用户点「＋」建 D2 并发送
		useSessionsStore.getState().activateNewSessionDraft("/proj/b");
		expect(useSessionsStore.getState().newSessionDraft?.cwd).toBe("/proj/b");
		const promoting2 = useSessionsStore.getState().createSession();

		expect(piMock.createSession).toHaveBeenCalledTimes(2);
		second.resolve(realMeta("new-2", "/proj/b"));
		expect(await promoting2).toBe("new-2");

		permission.resolve();
		expect(await promoting1).toBe("new-1");
		expect(useSessionsStore.getState().activeSessionId).toBe("new-2");
	});

	it("权限档位按**入口快照**冻结：创建在途时改 draft 档位，不影响已发出的这一次转正", async () => {
		const created = deferred<SessionMeta>();
		piMock.createSession.mockImplementationOnce(() => created.promise);
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().activateNewSessionDraft("/proj/a");
		useSessionsStore.getState().setDraftPermissionMode("fullAccess");
		const promoting = useSessionsStore.getState().createSession();

		// 创建在途：用户把 draft 档位改回 default（入口快照已冻结，本次仍按 fullAccess）
		useSessionsStore.getState().setDraftPermissionMode("default");
		created.resolve(realMeta("new-1", "/proj/a"));

		expect(await promoting).toBe("new-1");
		expect(piMock.setPermissionMode).toHaveBeenCalledWith({ sessionId: "new-1", mode: "fullAccess" });
	});

	it("promotion 在途时再点「＋」：复用同一 draft、不产生第二次 create、不覆盖配置与内容", async () => {
		const created = deferred<SessionMeta>();
		piMock.createSession.mockImplementationOnce(() => created.promise);
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().activateNewSessionDraft();
		useSessionsStore.getState().setDraftPermissionMode("fullAccess");
		useDraftStore.getState().updateDraft(NEW_SESSION_DRAFT_KEY, (d) => ({ ...d, text: "首条消息" }));

		const promoting = useSessionsStore.getState().createSession();
		useSessionsStore.getState().activateNewSessionDraft("/proj/other");

		// 同一份 draft：cwd / 权限模式 / 内容都不被重置
		expect(useSessionsStore.getState().newSessionDraft?.cwd).toBe("/proj/a");
		expect(useSessionsStore.getState().newSessionDraft?.permissionMode).toBe("fullAccess");
		expect(useDraftStore.getState().bySession[NEW_SESSION_DRAFT_KEY]?.text).toBe("首条消息");
		expect(piMock.createSession).toHaveBeenCalledTimes(1);

		created.resolve(realMeta("new-1", "/proj/a"));
		expect(await promoting).toBe("new-1");
		// 在途 re-activate 不是新的用户导航：转正成功后仍要落在新会话上
		expect(useSessionsStore.getState().activeSessionId).toBe("new-1");
		expect(useSessionsStore.getState().newSessionDraft).toBeNull();
	});
});

describe("不变式：新会话页（active === null）必须有可用 draft", () => {
	it("关闭最后一个会话 → 立刻补一份 draft（起步快照取刚关掉的那个会话）", async () => {
		useSessionsStore.setState({
			sessions: [
				{
					...realMeta("only", "/proj/only"),
					model: { provider: "pX", modelId: "mX" },
					thinkingLevel: "high",
				},
			],
			activeSessionId: "only",
			cwd: "/proj/only",
			newSessionDraft: null,
		});

		await useSessionsStore.getState().closeSession("only");

		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBeNull();
		expect(state.newSessionDraft?.cwd).toBe("/proj/only");
		expect(state.newSessionDraft?.model).toEqual({ provider: "pX", modelId: "mX" });
		expect(state.newSessionDraft?.thinkingLevel).toBe("high");
	});

	it("已有后台 draft 时关掉最后一个会话：保留原 draft，不拿被关会话覆盖", async () => {
		useSessionsStore.setState({ cwd: "/proj/draft" });
		useSessionsStore.getState().activateNewSessionDraft();
		const draft = useSessionsStore.getState().newSessionDraft;
		useSessionsStore.setState({
			sessions: [realMeta("only", "/proj/only")],
			activeSessionId: "only",
			cwd: "/proj/only",
		});

		await useSessionsStore.getState().closeSession("only");

		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBeNull();
		expect(state.newSessionDraft).toEqual(draft);
		// cwd 必须镜像 draft.cwd：否则页面/activeCwd 显示 A 项目、promotion 却按 B 项目建会话
		expect(state.cwd).toBe("/proj/draft");
		expect(state.newSessionDraft?.cwd).toBe("/proj/draft");
	});

	it("转正途中点「＋」回新会话页 → 迟到的转正结果消费掉 draft 后必须立刻补一份", async () => {
		const created = deferred<SessionMeta>();
		piMock.createSession.mockImplementationOnce(() => created.promise);
		useSessionsStore.setState({ cwd: "/proj/a" });
		useSessionsStore.getState().activateNewSessionDraft();
		const promoting = useSessionsStore.getState().createSession();

		// 切真实会话再点「＋」：领新号 → 在途那次转正变成「迟到」
		useSessionsStore.setState({ sessions: [realMeta("b", "/proj/b")], activeSessionId: "b", cwd: "/proj/b" });
		useSessionsStore.getState().switchSession("b");
		useSessionsStore.getState().activateNewSessionDraft();
		expect(useSessionsStore.getState().activeSessionId).toBeNull();

		created.resolve(realMeta("new-1", "/proj/a"));
		expect(await promoting).toBe("new-1");

		const state = useSessionsStore.getState();
		expect(state.activeSessionId).toBeNull(); // 迟到：不抢焦点
		expect(state.sessions.map((s) => s.sessionId)).toContain("new-1");
		// 关键：不能留下「空白新会话页 + 没有 draft」的破态（否则 picker 写入静默丢失）
		expect(state.newSessionDraft).not.toBeNull();
		expect(state.newSessionDraft?.cwd).toBe("/proj/a");
	});
});
