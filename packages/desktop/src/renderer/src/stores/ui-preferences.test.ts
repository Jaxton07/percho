import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：ui-preferences store 经 getPi() 访问，测试环境无 preload 注入 */
const piMock = vi.hoisted(() => ({
	loadUiState: vi.fn(),
	saveUiState: vi.fn(() => Promise.resolve()),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { useUiPreferencesStore } from "./ui-preferences";

beforeEach(() => {
	vi.clearAllMocks();
	useUiPreferencesStore.setState({
		centerOrbEnabled: false,
		pinnedSessions: [],
		barSessionsVisible: true,
		sidebarCollapsed: false,
		expandedGroups: [],
		pinnedProjects: [],
		lastCwd: null,
	});
});

describe("useUiPreferencesStore", () => {
	it("默认关闭（旧版本 ui-state 无该字段）", () => {
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(false);
	});

	it("init 从 ui-state 恢复开关", async () => {
		piMock.loadUiState.mockResolvedValue({ centerOrbEnabled: true });
		await useUiPreferencesStore.getState().init();
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(true);
	});

	it("init 加载失败或字段缺失时回落默认关闭", async () => {
		piMock.loadUiState.mockRejectedValue(new Error("no file"));
		await useUiPreferencesStore.getState().init();
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(false);

		piMock.loadUiState.mockResolvedValue({});
		await useUiPreferencesStore.getState().init();
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(false);
	});

	it("切换开关即持久化补丁", () => {
		useUiPreferencesStore.getState().setCenterOrbEnabled(true);
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(true);
		expect(piMock.saveUiState).toHaveBeenCalledWith({ state: { centerOrbEnabled: true } });
	});

	describe("左侧栏", () => {
		it("默认展开 + 显示顶栏（旧版本 ui-state 无这些字段）", async () => {
			piMock.loadUiState.mockResolvedValue({});
			await useUiPreferencesStore.getState().init();
			const state = useUiPreferencesStore.getState();
			expect(state.barSessionsVisible).toBe(true);
			expect(state.sidebarCollapsed).toBe(false);
			expect(state.expandedGroups).toEqual([]);
			expect(state.pinnedProjects).toEqual([]);
		});

		it("init 恢复收起态 / 顶栏显隐 / 展开分组 / 置顶项目", async () => {
			piMock.loadUiState.mockResolvedValue({
				barSessionsVisible: false,
				sidebarCollapsed: true,
				expandedGroups: ["__projects__", "/work/alpha"],
				pinnedProjects: ["/work/alpha"],
			});
			await useUiPreferencesStore.getState().init();
			const state = useUiPreferencesStore.getState();
			expect(state.barSessionsVisible).toBe(false);
			expect(state.sidebarCollapsed).toBe(true);
			expect(state.expandedGroups).toEqual(["__projects__", "/work/alpha"]);
			expect(state.pinnedProjects).toEqual(["/work/alpha"]);
		});

		it("四项各自落盘补丁（顶栏显隐 / 收起 / 展开分组 / 项目置顶）", () => {
			const store = useUiPreferencesStore.getState();
			store.setBarSessionsVisible(false);
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { barSessionsVisible: false } });

			store.toggleSidebarCollapsed();
			expect(useUiPreferencesStore.getState().sidebarCollapsed).toBe(true);
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { sidebarCollapsed: true } });

			store.setExpandedGroups(["__projects__"]);
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { expandedGroups: ["__projects__"] } });

			store.toggleProjectPin("/work/alpha");
			expect(useUiPreferencesStore.getState().pinnedProjects).toEqual(["/work/alpha"]);
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { pinnedProjects: ["/work/alpha"] } });

			store.toggleProjectPin("/work/alpha");
			expect(useUiPreferencesStore.getState().pinnedProjects).toEqual([]);
		});
	});

	describe("上次项目目录（lastCwd）", () => {
		it("默认 null（旧版本 ui-state 无该字段）", async () => {
			expect(useUiPreferencesStore.getState().lastCwd).toBeNull();

			piMock.loadUiState.mockResolvedValue({});
			await useUiPreferencesStore.getState().init();
			expect(useUiPreferencesStore.getState().lastCwd).toBeNull();
		});

		it("init 恢复上次项目目录", async () => {
			piMock.loadUiState.mockResolvedValue({ lastCwd: "/work/alpha" });
			await useUiPreferencesStore.getState().init();
			expect(useUiPreferencesStore.getState().lastCwd).toBe("/work/alpha");
		});

		it("setLastCwd 落盘；同值不重复写（切会话高频调用）、传 null 可清空", () => {
			useUiPreferencesStore.getState().setLastCwd("/work/alpha");
			expect(useUiPreferencesStore.getState().lastCwd).toBe("/work/alpha");
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { lastCwd: "/work/alpha" } });

			vi.clearAllMocks();
			useUiPreferencesStore.getState().setLastCwd("/work/alpha");
			expect(piMock.saveUiState).not.toHaveBeenCalled();

			useUiPreferencesStore.getState().setLastCwd(null);
			expect(useUiPreferencesStore.getState().lastCwd).toBeNull();
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { lastCwd: null } });
		});
	});

	describe("置顶会话", () => {
		it("默认空（旧版本 ui-state 无该字段）", async () => {
			expect(useUiPreferencesStore.getState().pinnedSessions).toEqual([]);

			piMock.loadUiState.mockResolvedValue({});
			await useUiPreferencesStore.getState().init();
			expect(useUiPreferencesStore.getState().pinnedSessions).toEqual([]);
		});

		it("init 恢复置顶列表", async () => {
			piMock.loadUiState.mockResolvedValue({ pinnedSessions: ["b", "a"] });
			await useUiPreferencesStore.getState().init();
			expect(useUiPreferencesStore.getState().pinnedSessions).toEqual(["b", "a"]);
		});

		it("置顶排最左、再点取消，每次都落盘", () => {
			const store = useUiPreferencesStore.getState();
			store.togglePin("a");
			expect(useUiPreferencesStore.getState().pinnedSessions).toEqual(["a"]);
			store.togglePin("b");
			expect(useUiPreferencesStore.getState().pinnedSessions).toEqual(["b", "a"]);
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { pinnedSessions: ["b", "a"] } });

			store.togglePin("b");
			expect(useUiPreferencesStore.getState().pinnedSessions).toEqual(["a"]);
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { pinnedSessions: ["a"] } });
		});

		it("unpin 清理删除的会话（不在列表里则不写盘）", () => {
			useUiPreferencesStore.setState({ pinnedSessions: ["b", "a"] });
			vi.clearAllMocks();

			useUiPreferencesStore.getState().unpin("b");
			expect(useUiPreferencesStore.getState().pinnedSessions).toEqual(["a"]);
			expect(piMock.saveUiState).toHaveBeenCalledTimes(1);

			useUiPreferencesStore.getState().unpin("ghost");
			expect(piMock.saveUiState).toHaveBeenCalledTimes(1);
		});
	});
});

describe("sessionPermissionModes 持久化（D7）", () => {
	beforeEach(() => {
		useUiPreferencesStore.setState({ sessionPermissionModes: {} });
	});

	it("非 default 写入并落盘；同值短路不重复写盘", () => {
		useUiPreferencesStore.getState().rememberPermissionMode("s1", "fullAccess");
		expect(useUiPreferencesStore.getState().sessionPermissionModes).toEqual({ s1: "fullAccess" });
		expect(piMock.saveUiState).toHaveBeenLastCalledWith({
			state: { sessionPermissionModes: { s1: "fullAccess" } },
		});
		const calls = piMock.saveUiState.mock.calls.length;
		useUiPreferencesStore.getState().rememberPermissionMode("s1", "fullAccess");
		expect(piMock.saveUiState.mock.calls.length).toBe(calls);
	});

	it("切回 default = 删键（且不动其他会话）", () => {
		useUiPreferencesStore.setState({ sessionPermissionModes: { s1: "fullAccess", s2: "fullAccess" } });
		useUiPreferencesStore.getState().rememberPermissionMode("s1", "default");
		expect(useUiPreferencesStore.getState().sessionPermissionModes).toEqual({ s2: "fullAccess" });
	});

	it("删除会话时 forget 清键；不存在的 id 无副作用（不写盘）", () => {
		useUiPreferencesStore.setState({ sessionPermissionModes: { s1: "fullAccess" } });
		useUiPreferencesStore.getState().forgetPermissionMode("s1");
		expect(useUiPreferencesStore.getState().sessionPermissionModes).toEqual({});
		const calls = piMock.saveUiState.mock.calls.length;
		useUiPreferencesStore.getState().forgetPermissionMode("ghost");
		expect(piMock.saveUiState.mock.calls.length).toBe(calls);
	});
});
