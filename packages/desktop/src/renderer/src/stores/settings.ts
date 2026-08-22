import type {
	CatalogPackage,
	CatalogPackageType,
	ConfiguredPackageInfo,
	CustomProviderInput,
	CustomProviderUpdateInput,
	LoadedExtension,
	LoadedSkill,
	LoginAuthPrompt,
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
	| "about"
	// 插件自带设置页分类（settings.panel 贡献动态拼接，id = plugin:<pluginName>:<contributionId>）
	| `plugin:${string}`;

/** 订阅登录（OAuth）流程的 UI 状态机；事件来自 backend LoginService 桥接 */
export interface LoginFlowState {
	/** renderer 生成的流程 id（事件归属/应答/取消关联） */
	loginId: string;
	providerId: string;
	providerName: string;
	/** 最新 progress/info 文案（SDK 原文） */
	statusLine?: string;
	/** info 事件附带的链接 */
	infoLinks?: readonly { url: string; label?: string }[];
	/** 浏览器授权地址（auth_url 事件；收到时自动开一次浏览器） */
	authUrl?: { url: string; instructions?: string };
	/** 设备码（device_code 事件；SDK 侧自行轮询） */
	deviceCode?: { userCode: string; verificationUri: string; expiresInSeconds?: number };
	/** 当前挂起的输入/选择提示（应答或 prompt-cancel 后清空） */
	pendingPrompt?: { promptId: string; prompt: LoginAuthPrompt };
	/** 流程已结束但失败（保留对话框展示错误；cancelled 直接关闭不设此字段） */
	error?: string;
}

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
	/** 视觉代理配置（null = 未加载） */
	visionConfig: VisionConfigInfo | null;
	/** 视觉模型连通性测试中 */
	visionTesting: boolean;
	visionTestResult: VisionTestResult | null;
	/** 当前活跃会话已加载的 skills（null = 未加载/无会话） */
	skills: LoadedSkill[] | null;
	skillDiagnostics: ResourceDiagnosticInfo[];
	/** 当前活跃会话已加载的扩展（null = 未加载/无会话） */
	extensions: LoadedExtension[] | null;
	extensionErrors: { path: string; error: string }[];
	/** 扩展面板分段：浏览社区 / 已加载 */
	extensionsTab: "browse" | "loaded";
	/** 社区包目录（pi.dev，服务端模糊搜索） */
	catalogQuery: string;
	catalogType: "" | CatalogPackageType;
	catalogPackages: CatalogPackage[];
	catalogTotal: number;
	catalogPage: number;
	catalogLoading: boolean;
	catalogLoadingMore: boolean;
	catalogError: string | null;
	/** 防陈旧响应：每次搜索自增，响应只认最新序号 */
	catalogSeq: number;
	/** 安装中的包名集合 */
	installingNames: Record<string, true>;
	/** 按包名的安装错误 */
	installErrors: Record<string, string>;
	/** 卸载中的 source 集合 */
	removingSources: Record<string, true>;
	/** 按 source 的卸载错误 */
	removeErrors: Record<string, string>;
	/** settings.json 已配置的包（null = 未加载；「已安装」态匹配/卸载用） */
	configuredPackages: ConfiguredPackageInfo[] | null;
	/** providerId → 测试结果（"testing" 表示进行中） */
	testResults: Record<string, ProviderTestResult | "testing">;
	/** 进行中的订阅登录流程（同一时刻一个；null = 无） */
	login: LoginFlowState | null;
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
	test: (providerId: string) => Promise<void>;
	setModelHidden: (provider: string, modelId: string, hidden: boolean) => Promise<void>;
	setSubagentModel: (agent: string, modelRef: string | null) => Promise<void>;
	/** 启动 provider 订阅登录（OAuth）；事件驱动 login 状态机，结束自动收尾 */
	startProviderLogin: (provider: ProviderInfo) => Promise<void>;
	/** 应答登录中的输入/选择提示 */
	respondLoginPrompt: (value: string) => void;
	/** 取消进行中的登录（invoke 收尾时统一清空状态） */
	cancelProviderLogin: () => void;
	/** 关闭登录对话框（错误态保留展示时用） */
	dismissLogin: () => void;
	setPermissionEnabled: (enabled: boolean) => Promise<void>;
	/** 保存视觉代理配置（返回是否成功；key 留空保持不变） */
	saveVision: (input: VisionSaveInput) => Promise<boolean>;
	/** 测试视觉模型连通性（1×1 png 实调） */
	testVision: () => Promise<void>;
	clearVisionTestResult: () => void;
	setExtensionsTab: (tab: "browse" | "loaded") => void;
	setCatalogQuery: (query: string) => void;
	setCatalogType: (type: "" | CatalogPackageType) => void;
	/** 搜索社区包目录；append=true 时加载下一页并追加 */
	searchCatalog: (append?: boolean) => Promise<void>;
	/** 安装社区包（用户级），成功后刷新已配置列表与已加载资源 */
	installCatalogPackage: (name: string) => Promise<void>;
	/** 卸载已配置的包，成功后刷新已配置列表与已加载资源 */
	removeConfiguredPackage: (source: string, scope: "user" | "project") => Promise<void>;
	refreshConfiguredPackages: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
	/** 变更后刷新 provider 列表与模型选择器数据 */
	const afterMutation = async () => {
		await get().refresh();
		await useSessionsStore.getState().loadModels();
	};

	/** 目录搜索防抖（query/type 变更 300ms 后触发） */
	let catalogDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleCatalogSearch = () => {
		clearTimeout(catalogDebounceTimer);
		catalogDebounceTimer = setTimeout(() => void get().searchCatalog(false), 300);
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
		visionConfig: null,
		visionTesting: false,
		visionTestResult: null,
		skills: null,
		skillDiagnostics: [],
		extensions: null,
		extensionErrors: [],
		extensionsTab: "browse",
		catalogQuery: "",
		catalogType: "",
		catalogPackages: [],
		catalogTotal: 0,
		catalogPage: 0,
		catalogLoading: false,
		catalogLoadingMore: false,
		catalogError: null,
		catalogSeq: 0,
		installingNames: {},
		installErrors: {},
		removingSources: {},
		removeErrors: {},
		configuredPackages: null,
		testResults: {},
		login: null,
		error: null,

		setOpen: (open) => {
			// 关闭设置时取消进行中的登录流程（对话框随面板卸载）
			if (!open) {
				const active = get().login;
				if (active && !active.error) void getPi().cancelProviderLogin(active.loginId);
				if (active) set({ login: null });
			}
			set({ open, testResults: {}, error: null });
			if (open) void get().refresh();
		},

		openWith: (category) => {
			set((state) => ({ category: category ?? state.category, open: true, testResults: {}, error: null }));
			void get().refresh();
		},

		setCategory: (category) => set({ category }),

		setExtensionsTab: (extensionsTab) => set({ extensionsTab }),

		setCatalogQuery: (catalogQuery) => {
			set({ catalogQuery });
			scheduleCatalogSearch();
		},

		setCatalogType: (catalogType) => {
			set({ catalogType });
			scheduleCatalogSearch();
		},

		searchCatalog: async (append = false) => {
			const { catalogQuery, catalogType, catalogPage, catalogSeq } = get();
			const page = append ? catalogPage + 1 : 1;
			const seq = catalogSeq + 1;
			set(
				append
					? { catalogSeq: seq, catalogLoadingMore: true, catalogError: null }
					: { catalogSeq: seq, catalogLoading: true, catalogError: null },
			);
			try {
				const result = await getPi().searchCatalog(catalogQuery, catalogType, page);
				if (get().catalogSeq !== seq) return; // 已有更新的搜索，丢弃陈旧响应
				set((state) => ({
					catalogPackages: append ? [...state.catalogPackages, ...result.packages] : result.packages,
					catalogTotal: result.total,
					catalogPage: result.page,
					catalogLoading: false,
					catalogLoadingMore: false,
				}));
			} catch (error) {
				if (get().catalogSeq !== seq) return;
				set({
					catalogLoading: false,
					catalogLoadingMore: false,
					catalogError: error instanceof Error ? error.message : String(error),
				});
			}
		},

		installCatalogPackage: async (name) => {
			set((state) => {
				const installErrors = { ...state.installErrors };
				delete installErrors[name];
				return { installingNames: { ...state.installingNames, [name]: true }, installErrors };
			});
			try {
				await getPi().installPackage(name);
				await get().refreshConfiguredPackages();
				// backend 已对非流式会话做 session.reload()，刷新已加载资源列表让「已加载」页同步
				void get().refresh();
			} catch (error) {
				set((state) => ({
					installErrors: {
						...state.installErrors,
						[name]: error instanceof Error ? error.message : String(error),
					},
				}));
			} finally {
				set((state) => {
					const installingNames = { ...state.installingNames };
					delete installingNames[name];
					return { installingNames };
				});
			}
		},

		refreshConfiguredPackages: async () => {
			try {
				const configured = await getPi().listConfiguredPackages();
				set({ configuredPackages: configured });
			} catch {
				set({ configuredPackages: [] });
			}
		},

		removeConfiguredPackage: async (source, scope) => {
			set((state) => {
				const removeErrors = { ...state.removeErrors };
				delete removeErrors[source];
				return { removingSources: { ...state.removingSources, [source]: true }, removeErrors };
			});
			try {
				await getPi().removePackage(source, scope);
				await get().refreshConfiguredPackages();
				// backend 已对非流式会话做 session.reload()，刷新已加载资源列表让「已加载」页同步
				void get().refresh();
			} catch (error) {
				set((state) => ({
					removeErrors: {
						...state.removeErrors,
						[source]: error instanceof Error ? error.message : String(error),
					},
				}));
			} finally {
				set((state) => {
					const removingSources = { ...state.removingSources };
					delete removingSources[source];
					return { removingSources };
				});
			}
		},

		refresh: async () => {
			set({ loading: true });
			// 权限门控配置是本地文件读，独立加载，不被 provider 列表阻塞
			void getPi()
				.getPermissionConfig()
				.then((permission) => set({ permissionEnabled: permission.enabled }))
				.catch(() => {});
			// 视觉代理配置同样本地文件读，独立加载
			void getPi()
				.getVisionConfig()
				.then((visionConfig) => set({ visionConfig }))
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

		setModelHidden: async (provider, modelId, hidden) => {
			const previous = get().modelPrefs;
			const base = previous ?? { hiddenModels: {}, subagentModels: {} };
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

		startProviderLogin: async (provider) => {
			if (get().login) return;
			const loginId = `login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			set({ login: { loginId, providerId: provider.id, providerName: provider.name } });
			// 每个流程只自动开一次浏览器（auth_url 可能重复发）
			let browserOpened = false;
			// 先订阅再 invoke：事件可能在 invoke 返回前到达
			const unsubscribe = getPi().onProviderLoginEvent((payload) => {
				if (payload.loginId !== loginId) return;
				const state = get().login;
				if (!state || state.loginId !== loginId) return;
				if (payload.kind === "prompt") {
					set({ login: { ...state, pendingPrompt: { promptId: payload.promptId, prompt: payload.prompt } } });
					return;
				}
				if (payload.kind === "prompt-cancel") {
					if (state.pendingPrompt?.promptId === payload.promptId) {
						set({ login: { ...state, pendingPrompt: undefined } });
					}
					return;
				}
				const event = payload.event;
				if (event.type === "auth_url") {
					set({ login: { ...state, authUrl: { url: event.url, instructions: event.instructions } } });
					if (!browserOpened) {
						browserOpened = true;
						void getPi().openExternal(event.url);
					}
				} else if (event.type === "device_code") {
					set({
						login: {
							...state,
							deviceCode: {
								userCode: event.userCode,
								verificationUri: event.verificationUri,
								expiresInSeconds: event.expiresInSeconds,
							},
						},
					});
				} else if (event.type === "progress") {
					set({ login: { ...state, statusLine: event.message } });
				} else if (event.type === "info") {
					set({ login: { ...state, statusLine: event.message, infoLinks: event.links } });
				}
			});
			try {
				const result = await getPi().startProviderLogin(loginId, provider.id);
				if (result.ok) {
					set({ login: null });
					// 凭证已持久化并同步运行时：刷新 provider 徽章 + 模型选择器
					await afterMutation();
				} else if (result.cancelled) {
					set({ login: null });
				} else {
					const state = get().login;
					if (state) {
						set({
							login: { ...state, pendingPrompt: undefined, error: result.error ?? "unknown error" },
						});
					}
				}
			} catch (error) {
				// invoke 层错误（并发守卫等）：保留对话框展示
				const state = get().login;
				if (state) {
					set({
						login: {
							...state,
							pendingPrompt: undefined,
							error: error instanceof Error ? error.message : String(error),
						},
					});
				}
			} finally {
				unsubscribe();
			}
		},

	/** 应答登录 prompt：await IPC 成功才清 pendingPrompt；失败恢复 prompt + 记 error（可重答） */
		respondLoginPrompt: async (value) => {
			const state = get().login;
			if (!state?.pendingPrompt) return;
			const { promptId } = state.pendingPrompt;
			try {
				await getPi().respondProviderLogin(state.loginId, promptId, value);
				set({ login: { ...state, pendingPrompt: undefined } });
			} catch (error) {
				set({ login: { ...state, error: error instanceof Error ? error.message : String(error) } });
			}
		},

		cancelProviderLogin: () => {
			const state = get().login;
			if (!state) return;
			void getPi().cancelProviderLogin(state.loginId);
		},

		dismissLogin: () => set({ login: null }),
	};
});
