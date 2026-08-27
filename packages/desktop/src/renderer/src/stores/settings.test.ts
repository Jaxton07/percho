import type { ContextManagerMode } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：settings store 经 getPi() 访问，测试环境无 preload 注入 */
const piMock = vi.hoisted(() => ({
	// refresh() 会并行拉多个本地配置，无关成员给最小 stub
	getPermissionConfig: vi.fn(() => Promise.resolve({ enabled: true })),
	getChannelWatchConfig: vi.fn(() => Promise.resolve({ enabled: true })),
	getVisionConfig: vi.fn(() => Promise.resolve({ hasKey: false })),
	lanGetStatus: vi.fn(() => Promise.resolve(null)),
	listProviders: vi.fn(() => Promise.resolve({ providers: [] })),
	listSubagents: vi.fn(() => Promise.resolve([])),
	getContextManagerConfig: vi.fn(() => Promise.resolve({ mode: "evaporation" })),
	setContextManagerMode: vi.fn(() => Promise.resolve()),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { useSettingsStore } from "./settings";

function resetStore() {
	useSettingsStore.setState({
		contextManagerMode: null,
		error: null,
		loading: false,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetStore();
});

describe("settings store：contextManagerMode（乐观更新 + 失败回滚）", () => {
	it("独立加载：getContextManagerConfig 结果进 store", async () => {
		piMock.getContextManagerConfig.mockResolvedValue({ mode: "evaporation" as ContextManagerMode });
		await useSettingsStore.getState().refresh();
		expect(useSettingsStore.getState().contextManagerMode).toBe("evaporation");
	});

	it("加载失败不置值（保持 null，静默）", async () => {
		piMock.getContextManagerConfig.mockRejectedValue(new Error("boom"));
		await useSettingsStore.getState().refresh();
		expect(useSettingsStore.getState().contextManagerMode).toBeNull();
	});

	it("切换成功：乐观更新生效", async () => {
		useSettingsStore.setState({ contextManagerMode: "off" });
		await useSettingsStore.getState().setContextManagerMode("evaporation");
		expect(piMock.setContextManagerMode).toHaveBeenCalledWith("evaporation");
		expect(useSettingsStore.getState().contextManagerMode).toBe("evaporation");
		expect(useSettingsStore.getState().error).toBeNull();
	});

	it("切换失败：回滚上一模式并记录错误", async () => {
		useSettingsStore.setState({ contextManagerMode: "evaporation" });
		piMock.setContextManagerMode.mockRejectedValue(new Error("disk full"));
		await useSettingsStore.getState().setContextManagerMode("off");
		expect(useSettingsStore.getState().contextManagerMode).toBe("evaporation");
		expect(useSettingsStore.getState().error).toBe("disk full");
	});
});
