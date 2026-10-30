import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：settings store 经 getPi() 访问，测试环境无 preload 注入 */
const piMock = vi.hoisted(() => ({
	// refresh() 会并行拉多个本地配置，无关成员给最小 stub
	getPermissionConfig: vi.fn(() => Promise.resolve({ enabled: true })),
	getChannelWatchConfig: vi.fn(() => Promise.resolve({ enabled: true })),
	setChannelWatchEnabled: vi.fn(() => Promise.resolve()),
	lanGetStatus: vi.fn(() => Promise.resolve(null)),
	listProviders: vi.fn(() => Promise.resolve([])),
	getModelPrefs: vi.fn(() => Promise.resolve({ hiddenModels: {}, subagentModels: {} })),
	listSubagents: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../api", () => ({
	getPi: () =>
		Object.assign(piMock, {
			forEnvironment: (environment: { kind: string }) => {
				if (environment.kind !== "local") throw new Error("Unexpected remote fixture");
				return piMock;
			},
		}),
}));

import { useSettingsStore } from "./settings";

function resetStore() {
	useSettingsStore.setState({
		channelWatchEnabled: null,
		error: null,
		loading: false,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetStore();
});

describe("settings store：channelWatchEnabled（乐观更新 + 失败回滚）", () => {
	it("独立加载：getChannelWatchConfig 结果进 store", async () => {
		piMock.getChannelWatchConfig.mockResolvedValue({ enabled: true });
		await useSettingsStore.getState().refresh();
		expect(useSettingsStore.getState().channelWatchEnabled).toBe(true);
	});

	it("加载失败不置值（保持 null，静默）", async () => {
		piMock.getChannelWatchConfig.mockRejectedValue(new Error("boom"));
		await useSettingsStore.getState().refresh();
		expect(useSettingsStore.getState().channelWatchEnabled).toBeNull();
	});

	it("切换成功：乐观更新生效", async () => {
		useSettingsStore.setState({ channelWatchEnabled: false });
		await useSettingsStore.getState().setChannelWatchEnabled(true);
		expect(piMock.setChannelWatchEnabled).toHaveBeenCalledWith({ enabled: true });
		expect(useSettingsStore.getState().channelWatchEnabled).toBe(true);
		expect(useSettingsStore.getState().error).toBeNull();
	});

	it("切换失败：回滚上一状态并记录错误", async () => {
		useSettingsStore.setState({ channelWatchEnabled: true });
		piMock.setChannelWatchEnabled.mockRejectedValue(new Error("disk full"));
		await useSettingsStore.getState().setChannelWatchEnabled(false);
		expect(useSettingsStore.getState().channelWatchEnabled).toBe(true);
		expect(useSettingsStore.getState().error).toBe("disk full");
	});
});
