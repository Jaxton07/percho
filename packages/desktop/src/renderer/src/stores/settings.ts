import type {
	CatalogPackage,
	CatalogPackageType,
	ConfiguredPackageInfo,
	CustomProviderInput,
	LoadedExtension,
	LoadedSkill,
	ProviderInfo,
	ProviderTestResult,
	ResourceDiagnosticInfo,
} from "@pi-desktop/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { useSessionsStore } from "./sessions";

export type SettingsCategory =
	| "general"
	| "appearance"
	| "providers"
	| "skills"
	| "mcp"
	| "extensions"
	| "about";

interface SettingsStore {
	open: boolean;
	/** 当前设置分类（/settings 命令可定位到指定面板） */
	category: SettingsCategory;
	providers: ProviderInfo[];
	loading: boolean;
	/** 内置权限门控开关（null = 未加载） */
	permissionEnabled: boolean | null;
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
	error: string | null;
	setOpen: (open: boolean) => void;
	/** 打开并（可选）定位到指定分类 */
	openWith: (category?: SettingsCategory) => void;
	setCategory: (category: SettingsCategory) => void;
	refresh: () => Promise<void>;
	saveKey: (providerId: string, key: string) => Promise<void>;
	removeCredential: (providerId: string) => Promise<void>;
	addCustom: (input: CustomProviderInput) => Promise<void>;
	removeCustom: (providerId: string) => Promise<void>;
	test: (providerId: string) => Promise<void>;
	setPermissionEnabled: (enabled: boolean) => Promise<void>;
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
		category: "providers",
		providers: [],
		loading: false,
		permissionEnabled: null,
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
			try {
				const [providers, permission] = await Promise.all([
					getPi().listProviders(),
					getPi().getPermissionConfig(),
				]);
				set({ providers, permissionEnabled: permission.enabled, loading: false, error: null });
				// 已加载资源按当前活跃会话（其项目）展示；无会话时为 null（面板显示空态）
				const activeSessionId = useSessionsStore.getState().activeSessionId;
				if (activeSessionId) {
					const resources = await getPi().getLoadedResources(activeSessionId);
					set({
						skills: resources.skills,
						skillDiagnostics: resources.skillDiagnostics,
						extensions: resources.extensions,
						extensionErrors: resources.extensionErrors,
					});
				} else {
					set({ skills: null, skillDiagnostics: [], extensions: null, extensionErrors: [] });
				}
			} catch (error) {
				set({ loading: false, error: error instanceof Error ? error.message : String(error) });
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

		removeCustom: async (providerId) => {
			try {
				await getPi().removeCustomProvider(providerId);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
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
