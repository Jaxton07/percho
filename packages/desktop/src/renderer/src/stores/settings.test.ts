import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：settings store 经 getPi() 访问，测试环境无 preload 注入 */
const piMock = vi.hoisted(() => ({
	// refresh() 会并行拉多个本地配置，无关成员给最小 stub
	getPermissionConfig: vi.fn(() => Promise.resolve({ enabled: true })),
	getChannelWatchConfig: vi.fn(() => Promise.resolve({ enabled: true })),
	getCodemodeConfig: vi.fn(() => Promise.resolve({ enabled: true, only: false })),
	setCodemodeOnly: vi.fn(() => Promise.resolve()),
	setCodemodeEnabled: vi.fn(() => Promise.resolve()),
	setChannelWatchEnabled: vi.fn(() => Promise.resolve()),
	getCompressionConfig: vi.fn(() =>
		Promise.resolve({ sdkAutoEnabled: true, guardEnabled: true, thresholdPct: 80 }),
	),
	setSdkAutoCompression: vi.fn(() =>
		Promise.resolve({ sdkAutoEnabled: false, guardEnabled: true, thresholdPct: 80 }),
	),
	setCompactionGuardEnabled: vi.fn(() =>
		Promise.resolve({ sdkAutoEnabled: false, guardEnabled: false, thresholdPct: 80 }),
	),
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
		compressionSdkAuto: null,
		compressionGuard: null,
		compressionSaving: false,
		codemodeEnabled: null,
		codemodeOnly: null,
		codemodeSaving: false,
		error: null,
		loading: false,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	resetStore();
});

describe("settings store：上下文压缩两层开关（乐观 + 后端回读权威值 + 失败回滚）", () => {
	it("独立加载：两层状态进 store；读不到保持 null", async () => {
		piMock.getCompressionConfig.mockResolvedValue({
			sdkAutoEnabled: true,
			guardEnabled: false,
			thresholdPct: 60,
		});
		await useSettingsStore.getState().refresh();
		expect(useSettingsStore.getState().compressionSdkAuto).toBe(true);
		expect(useSettingsStore.getState().compressionGuard).toBe(false);
		piMock.getCompressionConfig.mockRejectedValue(new Error("boom"));
		useSettingsStore.setState({ compressionSdkAuto: null, compressionGuard: null });
		await useSettingsStore.getState().refresh();
		expect(useSettingsStore.getState().compressionSdkAuto).toBeNull();
		expect(useSettingsStore.getState().compressionGuard).toBeNull();
	});

	it("关护栏：以后端回读的两层值为准（不只信本地那个开关）", async () => {
		useSettingsStore.setState({ compressionSdkAuto: false, compressionGuard: true });
		await useSettingsStore.getState().setCompressionGuard(false);
		expect(piMock.setCompactionGuardEnabled).toHaveBeenCalledWith({ enabled: false });
		expect(useSettingsStore.getState().compressionGuard).toBe(false);
		expect(useSettingsStore.getState().compressionSdkAuto).toBe(false);
		expect(useSettingsStore.getState().compressionSaving).toBe(false);
	});

	it("写失败：两层都回滚并记录错误", async () => {
		useSettingsStore.setState({ compressionSdkAuto: true, compressionGuard: true });
		piMock.setSdkAutoCompression.mockRejectedValueOnce(new Error("写盘失败"));
		await useSettingsStore.getState().setCompressionSdkAuto(false);
		expect(useSettingsStore.getState().compressionSdkAuto).toBe(true);
		expect(useSettingsStore.getState().compressionGuard).toBe(true);
		expect(useSettingsStore.getState().error).toBe("写盘失败");
		expect(useSettingsStore.getState().compressionSaving).toBe(false);
	});
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

describe("Code Mode 设置", () => {
	it("通用设置加载默认开启状态", async () => {
		await useSettingsStore.getState().refresh();
		expect(useSettingsStore.getState().codemodeEnabled).toBe(true);
		expect(useSettingsStore.getState().codemodeOnly).toBe(false);
	});

	it("保存成功才发布新状态；失败保留原值", async () => {
		useSettingsStore.setState({ codemodeEnabled: true });
		await useSettingsStore.getState().setCodemodeEnabled(false);
		expect(piMock.setCodemodeEnabled).toHaveBeenCalledWith({ enabled: false });
		expect(useSettingsStore.getState().codemodeEnabled).toBe(false);
		piMock.setCodemodeEnabled.mockRejectedValueOnce(new Error("disk full"));
		await useSettingsStore.getState().setCodemodeEnabled(true);
		expect(useSettingsStore.getState().codemodeEnabled).toBe(false);
		expect(useSettingsStore.getState().codemodeSaving).toBe(false);
		expect(useSettingsStore.getState().error).toBe("disk full");
	});

	it("保存之后到达的旧读取不能覆盖开关", async () => {
		let finish!: (config: { enabled: boolean; only: boolean }) => void;
		piMock.getCodemodeConfig.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await useSettingsStore.getState().refresh();
		await useSettingsStore.getState().setCodemodeEnabled(false);
		finish({ enabled: true, only: false });
		await Promise.resolve();
		expect(useSettingsStore.getState().codemodeEnabled).toBe(false);
	});
	it("独占模式保存成功后发布，失败保留原值", async () => {
		useSettingsStore.setState({ codemodeEnabled: true, codemodeOnly: false });
		await useSettingsStore.getState().setCodemodeOnly(true);
		expect(piMock.setCodemodeOnly).toHaveBeenCalledWith({ only: true });
		expect(useSettingsStore.getState().codemodeOnly).toBe(true);
		piMock.setCodemodeOnly.mockRejectedValueOnce(new Error("disk full"));
		await useSettingsStore.getState().setCodemodeOnly(false);
		expect(useSettingsStore.getState().codemodeOnly).toBe(true);
		expect(useSettingsStore.getState().error).toBe("disk full");
		expect(useSettingsStore.getState().codemodeSaving).toBe(false);
	});
});
