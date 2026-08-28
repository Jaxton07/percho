import type {
	ContextManagerMode,
	CustomProviderInput,
	CustomProviderUpdateInput,
	LanStatus,
	LoadedExtension,
	LoadedSkill,
	ModelPrefs,
	ProviderInfo,
	ProviderTestResult,
	ResourceDiagnosticInfo,
	SubagentInfo,
	VisionConfigInfo,
	VisionSaveInput,
	VisionTestResult,
} from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { isDraftSessionId, useSessionsStore } from "./sessions";

export type SettingsCategory =
	| "general"
	| "appearance"
	| "models"
	| "skills"
	| "mcp"
	| "extensions"
	| "uiPlugins"
	| "vision"
	| "lan"
	| "about"
	// 插件自带设置页分类（settings.panel 贡献动态拼接，id = plugin:<pluginName>:<contributionId>）
	| `plugin:${string}`;

interface SettingsStore {
	open: boolean;
	/** 当前设置分类（/settings 命令可定位到指定面板） */
	category: SettingsCategory;
	providers: ProviderInfo[];
	/** 用户级模型可见性与子代理模型覆盖（null = 未加载） */
	modelPrefs: ModelPrefs | null;
	subagents: SubagentInfo[];
	loading: boolean;
	/** 联网刷新模型目录进行中（默认刷新只走本地，见 refreshProvidersFromNetwork） */
	refreshing: boolean;
	/** 内置权限门控开关（null = 未加载） */
	permissionEnabled: boolean | null;
	/** 上下文管理模式（evaporation / off；null = 未加载） */
	contextManagerMode: ContextManagerMode | null;
	/** channel-watch 跨会话频道唤醒开关（null = 未加载） */
	channelWatchEnabled: boolean | null;
	/** 视觉代理配置（null = 未加载） */
	visionConfig: VisionConfigInfo | null;
	/** 视觉模型连通性测试中 */
	visionTesting: boolean;
	/** 局域网观察服务运行状态（null = 未加载）。 */
	lanStatus: LanStatus | null;
	lanSaving: boolean;
	visionTestResult: VisionTestResult | null;
	/** 当前活跃会话已加载的 skills（null = 未加载/无会话） */
	skills: LoadedSkill[] | null;
	skillDiagnostics: ResourceDiagnosticInfo[];
	/** 当前活跃会话已加载的扩展（null = 未加载/无会话） */
	extensions: LoadedExtension[] | null;
	extensionErrors: { path: string; error: string }[];
	/** providerId → 测试结果（"testing" 表示进行中） */
	testResults: Record<string, ProviderTestResult | "testing">;
	error: string | null;
	setOpen: (open: boolean) => void;
	/** 打开并（可选）定位到指定分类 */
	openWith: (category?: SettingsCategory) => void;
	setCategory: (category: SettingsCategory) => void;
	refresh: () => Promise<void>;
	/** 从 pi.dev 联网拉取最新模型目录（绕过新鲜度窗口；成功后同步模型选择器数据） */
	refreshProvidersFromNetwork: () => Promise<void>;
	saveKey: (providerId: string, key: string) => Promise<void>;
	removeCredential: (providerId: string) => Promise<void>;
	addCustom: (input: CustomProviderInput) => Promise<void>;
	updateCustom: (input: CustomProviderUpdateInput) => Promise<void>;
	removeCustom: (providerId: string) => Promise<void>;
	/** 内置 provider 的可选 baseUrl 覆写（留空 = 清除覆写回官方） */
	setProviderBaseUrl: (providerId: string, baseUrl: string, apiKey?: string) => Promise<void>;
	test: (providerId: string) => Promise<void>;
	setModelHidden: (provider: string, modelId: string, hidden: boolean) => Promise<void>;
	setModelsHidden: (provider: string, modelIds: string[], hidden: boolean) => Promise<void>;
	setSubagentModel: (agent: string, modelRef: string | null) => Promise<void>;
	setPermissionEnabled: (enabled: boolean) => Promise<void>;
	setContextManagerMode: (mode: ContextManagerMode) => Promise<void>;
	setChannelWatchEnabled: (enabled: boolean) => Promise<void>;
	/** 保存视觉代理配置（返回是否成功；key 留空保持不变） */
	saveVision: (input: VisionSaveInput) => Promise<boolean>;
	/** 测试视觉模型连通性（1×1 png 实调） */
	testVision: () => Promise<void>;
	clearVisionTestResult: () => void;
	refreshLanStatus: () => Promise<void>;
	setLanEnabled: (enabled: boolean) => Promise<void>;
	setLanRemoteControl: (enabled: boolean) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
	/** 变更后刷新 provider 列表与模型选择器数据 */
	const afterMutation = async () => {
		await get().refresh();
		await useSessionsStore.getState().loadModels();
	};

	return {
		open: false,
		category: "models",
		providers: [],
		modelPrefs: null,
		subagents: [],
		loading: false,
		refreshing: false,
		permissionEnabled: null,
		contextManagerMode: null,
		channelWatchEnabled: null,
		visionConfig: null,
		visionTesting: false,
		visionTestResult: null,
		lanStatus: null,
		lanSaving: false,
		skills: null,
		skillDiagnostics: [],
		extensions: null,
		extensionErrors: [],
		testResults: {},
		error: null,

		setOpen: (open) => {
			set({ open, testResults: {}, error: null });
			if (open) void get().refresh();
		},

		openWith: (category) => {
			set((state) => ({ category: category ?? state.category, open: true, testResults: {}, error: null }));
			void get().refresh();
		},

		setCategory: (category) => set({ category }),

		refresh: async () => {
			set({ loading: true });
			// 权限门控配置是本地文件读，独立加载，不被 provider 列表阻塞
			void getPi()
				.getPermissionConfig()
				.then((permission) => set({ permissionEnabled: permission.enabled }))
				.catch(() => {});
			// 上下文管理模式二态同样本地文件读，独立加载
			void getPi()
				.getContextManagerConfig()
				.then((cm) => set({ contextManagerMode: cm.mode }))
				.catch(() => {});
			// channel-watch 开关同样本地文件读，独立加载
			void getPi()
				.getChannelWatchConfig()
				.then((cw) => set({ channelWatchEnabled: cw.enabled }))
				.catch(() => {});
			// 视觉代理配置同样本地文件读，独立加载
			void getPi()
				.getVisionConfig()
				.then((visionConfig) => set({ visionConfig }))
				.catch(() => {});
			void getPi()
				.lanGetStatus()
				.then((lanStatus) => set({ lanStatus }))
				.catch(() => {});
			try {
				const [providers, modelPrefs, subagents] = await Promise.all([
					getPi().listProviders(),
					getPi().getModelPrefs(),
					getPi().listSubagents(),
				]);
				set({ providers, modelPrefs, subagents, loading: false, error: null });
				// 已加载资源按当前活跃会话（其项目）展示；无会话或 draft（未真正创建）时为 null（面板显示空态）
				const activeSessionId = useSessionsStore.getState().activeSessionId;
				if (activeSessionId && !isDraftSessionId(activeSessionId)) {
					const resources = await getPi().getLoadedResources(activeSessionId);
					// 竞态守卫：await 期间活跃会话已切换则丢弃（防把 A 项目的资源写到 B 会话的面板）
					if (useSessionsStore.getState().activeSessionId === activeSessionId) {
						set({
							skills: resources.skills,
							skillDiagnostics: resources.skillDiagnostics,
							extensions: resources.extensions,
							extensionErrors: resources.extensionErrors,
						});
					}
				} else {
					set({ skills: null, skillDiagnostics: [], extensions: null, extensionErrors: [] });
				}
			} catch (error) {
				set({ loading: false, error: error instanceof Error ? error.message : String(error) });
			}
		},

		refreshProvidersFromNetwork: async () => {
			set({ refreshing: true, error: null });
			try {
				const providers = await getPi().listProviders({ forceNetwork: true });
				set({ providers, refreshing: false });
				// runtime 已持有最新目录，本地刷新模型选择器数据即可
				await useSessionsStore.getState().loadModels();
			} catch (error) {
				set({ refreshing: false, error: error instanceof Error ? error.message : String(error) });
			}
		},

		setPermissionEnabled: async (enabled) => {
			const previous = get().permissionEnabled;
			set({ permissionEnabled: enabled });
			try {
				await getPi().setPermissionEnabled(enabled);
			} catch (error) {
				set({
					permissionEnabled: previous,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},

		setContextManagerMode: async (mode) => {
			const previous = get().contextManagerMode;
			set({ contextManagerMode: mode });
			try {
				await getPi().setContextManagerMode(mode);
			} catch (error) {
				set({
					contextManagerMode: previous,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},

		setChannelWatchEnabled: async (enabled) => {
			const previous = get().channelWatchEnabled;
			set({ channelWatchEnabled: enabled });
			try {
				await getPi().setChannelWatchEnabled(enabled);
			} catch (error) {
				set({
					channelWatchEnabled: previous,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},

		saveVision: async (input) => {
			try {
				const visionConfig = await getPi().saveVisionConfig(input);
				set({ visionConfig, visionTestResult: null });
				return true;
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
				return false;
			}
		},

		testVision: async () => {
			set({ visionTesting: true, visionTestResult: null });
			try {
				const result = await getPi().testVision();
				set({ visionTesting: false, visionTestResult: result });
			} catch (error) {
				set({
					visionTesting: false,
					visionTestResult: { ok: false, message: error instanceof Error ? error.message : String(error) },
				});
			}
		},

		clearVisionTestResult: () => set({ visionTestResult: null }),

		refreshLanStatus: async () => {
			try {
				set({ lanStatus: await getPi().lanGetStatus() });
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		},

		setLanEnabled: async (enabled) => {
			set({ lanSaving: true });
			try {
				const lanStatus = await getPi().lanSetEnabled(enabled);
				set({ lanStatus, lanSaving: false });
			} catch (error) {
				set({ lanSaving: false, error: error instanceof Error ? error.message : String(error) });
			}
		},

		setLanRemoteControl: async (enabled) => {
			set({ lanSaving: true });
			try {
				const lanStatus = await getPi().lanSetRemoteControl(enabled);
				set({ lanStatus, lanSaving: false });
			} catch (error) {
				set({ lanSaving: false, error: error instanceof Error ? error.message : String(error) });
			}
		},

		saveKey: async (providerId, key) => {
			try {
				await getPi().saveApiKey(providerId, key);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		},

		removeCredential: async (providerId) => {
			try {
				await getPi().removeCredential(providerId);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		},

		addCustom: async (input) => {
			try {
				await getPi().addCustomProvider(input);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		},

		updateCustom: async (input) => {
			try {
				await getPi().updateCustomProvider(input);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		},

		removeCustom: async (providerId) => {
			try {
				await getPi().removeCustomProvider(providerId);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		},

		setProviderBaseUrl: async (providerId, baseUrl, apiKey) => {
			try {
				await getPi().setProviderBaseUrl(providerId, baseUrl, apiKey);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		},

		setModelHidden: async (provider, modelId, hidden) => {
			const previous = get().modelPrefs;
			const base: ModelPrefs = previous ?? { hiddenModels: {}, subagentModels: {} };
			const ids = new Set(base.hiddenModels[provider] ?? []);
			if (hidden) ids.add(modelId);
			else ids.delete(modelId);
			const hiddenModels = { ...base.hiddenModels };
			if (ids.size) hiddenModels[provider] = [...ids];
			else delete hiddenModels[provider];
			// 先本地更新，开关圆点不必等待 Electron IPC 往返；失败时以磁盘实际状态回滚。
			set({ modelPrefs: { ...base, hiddenModels } });
			try {
				await getPi().setModelHidden(provider, modelId, hidden);
				await useSessionsStore.getState().loadModels();
			} catch (error) {
				const modelPrefs = await getPi()
					.getModelPrefs()
					.catch(() => previous);
				set({ modelPrefs, error: error instanceof Error ? error.message : String(error) });
			}
		},

		setModelsHidden: async (provider, modelIds, hidden) => {
			const previous = get().modelPrefs;
			const base: ModelPrefs = previous ?? { hiddenModels: {}, subagentModels: {} };
			const hiddenSet = new Set(base.hiddenModels[provider] ?? []);
			for (const id of modelIds) {
				if (hidden) hiddenSet.add(id);
				else hiddenSet.delete(id);
			}
			const hiddenModels = { ...base.hiddenModels };
			if (hiddenSet.size) hiddenModels[provider] = [...hiddenSet];
			else delete hiddenModels[provider];
			// 先本地更新（一次 IPC 写盘，不逐个往返）；失败时以磁盘实际状态回滚。
			set({ modelPrefs: { ...base, hiddenModels } });
			try {
				await getPi().setModelsHidden(provider, modelIds, hidden);
				await useSessionsStore.getState().loadModels();
			} catch (error) {
				const modelPrefs = await getPi()
					.getModelPrefs()
					.catch(() => previous);
				set({ modelPrefs, error: error instanceof Error ? error.message : String(error) });
			}
		},

		setSubagentModel: async (agent, modelRef) => {
			const previous = get().modelPrefs;
			try {
				const modelPrefs = await getPi().setSubagentModel(agent, modelRef);
				set({ modelPrefs });
			} catch (error) {
				set({ modelPrefs: previous, error: error instanceof Error ? error.message : String(error) });
			}
		},

		test: async (providerId) => {
			set((state) => ({ testResults: { ...state.testResults, [providerId]: "testing" } }));
			try {
				const result = await getPi().testProvider(providerId);
				set((state) => ({ testResults: { ...state.testResults, [providerId]: result } }));
			} catch (error) {
				set((state) => ({
					testResults: {
						...state.testResults,
						[providerId]: { ok: false, error: error instanceof Error ? error.message : String(error) },
					},
				}));
			}
		},
	};
});
