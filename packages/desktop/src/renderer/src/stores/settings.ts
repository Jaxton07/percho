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
} from "@percho/shared";
import { withModelHidden, withModelsHidden, withProviderModelsHidden } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { useSessionsStore } from "./sessions";

export type SettingsCategory =
	| "general"
	| "appearance"
	| "models"
	| "skills"
	| "mcp"
	| "extensions"
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
	/** 内置权限门控已被手改 permissions.json 关闭（逃生舱态；null = 未加载，false 不禁用 chip） */
	permissionGateOff: boolean | null;
	/** 上下文管理模式（evaporation / off；null = 未加载） */
	contextManagerMode: ContextManagerMode | null;
	/** channel-watch 跨会话频道唤醒开关（null = 未加载） */
	channelWatchEnabled: boolean | null;
	/** 局域网观察服务运行状态（null = 未加载）。 */
	lanStatus: LanStatus | null;
	lanSaving: boolean;
	/** 当前活跃会话已加载的 skills（null = 未加载/无会话） */
	skills: LoadedSkill[] | null;
	skillDiagnostics: ResourceDiagnosticInfo[];
	/** 当前活跃会话已加载的扩展（null = 未加载/无会话） */
	extensions: LoadedExtension[] | null;
	extensionErrors: { path: string; error: string; level: "error" | "info" }[];
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
	setProviderModelsHidden: (provider: string, hidden: boolean) => Promise<void>;
	setSubagentModel: (agent: string, modelRef: string | null) => Promise<void>;
	/** 逐代理思考深度覆盖；null = 跟随 agent 定义 */
	setSubagentThinking: (agent: string, level: string | null) => Promise<void>;
	/** 内置 subagent 执行器优先（新会话生效） */
	setSubagentPreferBuiltin: (enabled: boolean) => Promise<void>;
	setContextManagerMode: (mode: ContextManagerMode) => Promise<void>;
	setChannelWatchEnabled: (enabled: boolean) => Promise<void>;
	refreshLanStatus: () => Promise<void>;
	setLanEnabled: (enabled: boolean) => Promise<void>;
	setLanRemoteControl: (enabled: boolean) => Promise<void>;
}

/** Electron `invoke` 的失败信息带前缀（`Error invoking remote method '<channel>': Error: `），
 *  剥掉它只留后端原文 —— 表单校验提示（provider ID 非法 / 旧 provider 已改名 等）才读得懂 */
function errorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
	// modelPrefs 的单写者：已确认底座 + 未完成操作重放；读与所有偏好 IPC 共用串行尾链。
	let confirmedPrefs: ModelPrefs | null = null;
	let prefsTail: Promise<void> = Promise.resolve();
	type PrefOperation = { apply: (prefs: ModelPrefs) => ModelPrefs };
	let pendingPrefs: PrefOperation[] = [];
	const publishPrefs = () => {
		const base = confirmedPrefs ?? { hiddenModels: {}, subagentModels: {} };
		set({
			modelPrefs: pendingPrefs.length
				? pendingPrefs.reduce((prefs, op) => op.apply(prefs), base)
				: confirmedPrefs,
		});
	};
	const enqueuePrefs = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = prefsTail.then(operation);
		prefsTail = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	const readPrefs = () =>
		enqueuePrefs(async () => {
			confirmedPrefs = await getPi().getModelPrefs();
			publishPrefs();
		});
	const changePrefs = (
		apply: PrefOperation["apply"],
		commit: () => Promise<ModelPrefs>,
		refreshModels = false,
	): Promise<void> => {
		if (!pendingPrefs.length) confirmedPrefs = get().modelPrefs;
		// 先验证本次投影；非法输入不得留下永远不会发送的 pending 操作。
		apply(get().modelPrefs ?? { hiddenModels: {}, subagentModels: {} });
		const op = { apply };
		pendingPrefs.push(op);
		const result = enqueuePrefs(async () => {
			let succeeded = false;
			try {
				confirmedPrefs = await commit();
				succeeded = true;
			} catch (error) {
				pendingPrefs = pendingPrefs.filter((pending) => pending !== op);
				publishPrefs();
				// 队列仍被当前操作占住；后继 IPC 未发送，重读不会返回过期的后继快照。
				try {
					confirmedPrefs = await getPi().getModelPrefs();
				} catch {
					/* 保留最后确认值 */
				}
				set({ error: errorMessage(error) });
			} finally {
				pendingPrefs = pendingPrefs.filter((pending) => pending !== op);
				publishPrefs();
			}
			if (succeeded && refreshModels) await useSessionsStore.getState().loadModels();
		});
		// 先排队再通知订阅者：同步订阅里发起新动作时仍保留原始调用顺序。
		publishPrefs();
		return result;
	};

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
		permissionGateOff: null,
		contextManagerMode: null,
		channelWatchEnabled: null,
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
			set({ loading: true, error: null });
			// 权限门控配置是本地文件读，独立加载，不被 provider 列表阻塞
			// （仅派生 enabled=false 逃生舱态供 chip 禁用提示；开关 UI 已撒，spec permission-mode D7）
			void getPi()
				.getPermissionConfig()
				.then((permission) => set({ permissionGateOff: !permission.enabled }))
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
			void getPi()
				.lanGetStatus()
				.then((lanStatus) => set({ lanStatus }))
				.catch(() => {});
			try {
				const [providers, , subagents] = await Promise.all([
					getPi().listProviders({}),
					readPrefs(),
					getPi().listSubagents(),
				]);
				// modelPrefs 已由串行读路径发布，不能等目录返回后再写入旧快照。
				set({ providers, subagents, loading: false });
				// 已加载资源按当前活跃会话（其项目）展示；新会话页（还没建后端会话）时为 null（面板显示空态）
				const activeSessionId = useSessionsStore.getState().activeSessionId;
				if (activeSessionId) {
					const resources = await getPi().getLoadedResources({ sessionId: activeSessionId });
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
				const providers = await getPi().listProviders({ options: { forceNetwork: true } });
				set({ providers, refreshing: false });
				// runtime 已持有最新目录，本地刷新模型选择器数据即可
				await useSessionsStore.getState().loadModels();
			} catch (error) {
				set({ refreshing: false, error: error instanceof Error ? error.message : String(error) });
			}
		},

		setContextManagerMode: async (mode) => {
			const previous = get().contextManagerMode;
			set({ contextManagerMode: mode });
			try {
				await getPi().setContextManagerMode({ mode });
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
				await getPi().setChannelWatchEnabled({ enabled });
			} catch (error) {
				set({
					channelWatchEnabled: previous,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},

		refreshLanStatus: async () => {
			try {
				set({ lanStatus: await getPi().lanGetStatus() });
			} catch (error) {
				set({ error: errorMessage(error) });
			}
		},

		setLanEnabled: async (enabled) => {
			set({ lanSaving: true });
			try {
				const lanStatus = await getPi().lanSetEnabled({ enabled });
				set({ lanStatus, lanSaving: false });
			} catch (error) {
				set({ lanSaving: false, error: error instanceof Error ? error.message : String(error) });
			}
		},

		setLanRemoteControl: async (enabled) => {
			set({ lanSaving: true });
			try {
				const lanStatus = await getPi().lanSetRemoteControl({ enabled });
				set({ lanStatus, lanSaving: false });
			} catch (error) {
				set({ lanSaving: false, error: error instanceof Error ? error.message : String(error) });
			}
		},

		saveKey: async (providerId, key) => {
			try {
				await getPi().saveApiKey({ providerId, key });
				await afterMutation();
			} catch (error) {
				set({ error: errorMessage(error) });
			}
		},

		removeCredential: async (providerId) => {
			try {
				await getPi().removeCredential({ providerId });
				await afterMutation();
			} catch (error) {
				set({ error: errorMessage(error) });
			}
		},

		addCustom: async (input) => {
			try {
				await getPi().addCustomProvider({ input });
				await afterMutation();
			} catch (error) {
				set({ error: errorMessage(error) });
				throw error;
			}
		},

		updateCustom: async (input) => {
			try {
				await getPi().updateCustomProvider({ input });
				await afterMutation();
			} catch (error) {
				set({ error: errorMessage(error) });
				throw error;
			}
		},

		removeCustom: async (providerId) => {
			try {
				await getPi().removeCustomProvider({ providerId });
				await afterMutation();
			} catch (error) {
				set({ error: errorMessage(error) });
			}
		},

		setProviderBaseUrl: async (providerId, baseUrl, apiKey) => {
			try {
				await getPi().setProviderBaseUrl({ providerId, baseUrl, apiKey });
				await afterMutation();
			} catch (error) {
				set({ error: errorMessage(error) });
				throw error;
			}
		},

		setModelHidden: async (provider, modelId, hidden) =>
			changePrefs(
				(prefs) => withModelHidden(prefs, provider, modelId, hidden),
				() => getPi().setModelHidden({ provider, modelId, hidden }),
				true,
			),

		setModelsHidden: async (provider, modelIds, hidden) => {
			const ids = [...modelIds]; // 固定点击时的意图，不受调用方后续数组修改影响
			return changePrefs(
				(prefs) => withModelsHidden(prefs, provider, ids, hidden),
				() => getPi().setModelsHidden({ provider, modelIds: ids, hidden }),
				true,
			);
		},

		setProviderModelsHidden: async (provider, hidden) =>
			changePrefs(
				(prefs) => withProviderModelsHidden(prefs, provider, hidden),
				() => getPi().setProviderModelsHidden({ provider, hidden }),
				true,
			),

		setSubagentModel: async (agent, modelRef) =>
			changePrefs(
				(prefs) => {
					const next = { ...prefs, subagentModels: { ...prefs.subagentModels } };
					if (modelRef) next.subagentModels[agent] = modelRef;
					else delete next.subagentModels[agent];
					return next;
				},
				() => getPi().setSubagentModel({ agent, modelRef }),
			),

		setSubagentThinking: async (agent, level) =>
			changePrefs(
				(prefs) => {
					const thinking = { ...prefs.subagentThinking };
					const next: ModelPrefs = { ...prefs, subagentThinking: thinking };
					if (level) thinking[agent] = level;
					else delete thinking[agent];
					if (!Object.keys(thinking).length) delete next.subagentThinking;
					return next;
				},
				() => getPi().setSubagentThinking({ agent, level }),
			),

		setSubagentPreferBuiltin: async (enabled) =>
			changePrefs(
				(prefs) => ({ ...prefs, subagentPreferBuiltin: enabled }),
				() => getPi().setSubagentPreferBuiltin({ enabled }),
			),

		test: async (providerId) => {
			set((state) => ({ testResults: { ...state.testResults, [providerId]: "testing" } }));
			try {
				const result = await getPi().testProvider({ providerId });
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
