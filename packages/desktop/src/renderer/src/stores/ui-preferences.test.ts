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
		topBarVisible: true,
		sidebarCollapsed: false,
		expandedGroups: [],
		pinnedProjects: [],
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
			expect(state.topBarVisible).toBe(true);
			expect(state.sidebarCollapsed).toBe(false);
			expect(state.expandedGroups).toEqual([]);
			expect(state.pinnedProjects).toEqual([]);
		});

		it("init 恢复收起态 / 顶栏显隐 / 展开分组 / 置顶项目", async () => {
			piMock.loadUiState.mockResolvedValue({
				topBarVisible: false,
				sidebarCollapsed: true,
				expandedGroups: ["__projects__", "/work/alpha"],
				pinnedProjects: ["/work/alpha"],
			});
			await useUiPreferencesStore.getState().init();
			const state = useUiPreferencesStore.getState();
			expect(state.topBarVisible).toBe(false);
			expect(state.sidebarCollapsed).toBe(true);
			expect(state.expandedGroups).toEqual(["__projects__", "/work/alpha"]);
			expect(state.pinnedProjects).toEqual(["/work/alpha"]);
		});

		it("四项各自落盘补丁（顶栏显隐 / 收起 / 展开分组 / 项目置顶）", () => {
			const store = useUiPreferencesStore.getState();
			store.setTopBarVisible(false);
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { topBarVisible: false } });

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
