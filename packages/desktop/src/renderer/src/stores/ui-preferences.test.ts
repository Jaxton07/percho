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
		sessionRailEnabled: false,
		centerOrbEnabled: false,
		pinnedSessions: [],
		sessionListMode: "tabbar",
	});
});

describe("useUiPreferencesStore", () => {
	it("默认关闭（旧版本 ui-state 无该字段）", () => {
		expect(useUiPreferencesStore.getState().sessionRailEnabled).toBe(false);
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(false);
	});

	it("init 从 ui-state 恢复开关", async () => {
		piMock.loadUiState.mockResolvedValue({ sessionRailEnabled: true, centerOrbEnabled: true });
		await useUiPreferencesStore.getState().init();
		expect(useUiPreferencesStore.getState().sessionRailEnabled).toBe(true);
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(true);
	});

	it("init 加载失败或字段缺失时回落默认关闭", async () => {
		piMock.loadUiState.mockRejectedValue(new Error("no file"));
		await useUiPreferencesStore.getState().init();
		expect(useUiPreferencesStore.getState().sessionRailEnabled).toBe(false);
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(false);

		piMock.loadUiState.mockResolvedValue({});
		await useUiPreferencesStore.getState().init();
		expect(useUiPreferencesStore.getState().sessionRailEnabled).toBe(false);
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(false);
	});

	it("切换开关即持久化补丁", () => {
		useUiPreferencesStore.getState().setSessionRailEnabled(true);
		expect(useUiPreferencesStore.getState().sessionRailEnabled).toBe(true);
		expect(piMock.saveUiState).toHaveBeenCalledWith({ state: { sessionRailEnabled: true } });

		useUiPreferencesStore.getState().setCenterOrbEnabled(true);
		expect(useUiPreferencesStore.getState().centerOrbEnabled).toBe(true);
		expect(piMock.saveUiState).toHaveBeenCalledWith({ state: { centerOrbEnabled: true } });
	});

	describe("会话列表位置", () => {
		it("默认顶栏（旧版本 ui-state 无该字段）", async () => {
			expect(useUiPreferencesStore.getState().sessionListMode).toBe("tabbar");

			piMock.loadUiState.mockResolvedValue({});
			await useUiPreferencesStore.getState().init();
			expect(useUiPreferencesStore.getState().sessionListMode).toBe("tabbar");
		});

		it("init 恢复悬浮模式", async () => {
			piMock.loadUiState.mockResolvedValue({ sessionListMode: "floating" });
			await useUiPreferencesStore.getState().init();
			expect(useUiPreferencesStore.getState().sessionListMode).toBe("floating");
		});

		it("切换即落盘补丁", () => {
			useUiPreferencesStore.getState().setSessionListMode("floating");
			expect(useUiPreferencesStore.getState().sessionListMode).toBe("floating");
			expect(piMock.saveUiState).toHaveBeenCalledWith({ state: { sessionListMode: "floating" } });

			useUiPreferencesStore.getState().setSessionListMode("tabbar");
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({ state: { sessionListMode: "tabbar" } });
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
