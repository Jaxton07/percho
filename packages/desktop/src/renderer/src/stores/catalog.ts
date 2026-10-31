import type {
	CatalogPackage,
	CatalogPackageType,
	ConfiguredPackageInfo,
	PackageUpdateInfo,
} from "@percho/shared";
import { type EnvironmentRef, environmentKey, environmentRef, LOCAL_ENVIRONMENT } from "@percho/shared";
import { create, useStore } from "zustand";
import { getExecutionApi } from "../environment-api";
import { useEnvironment } from "../environment-context";
import { getSettingsStore } from "./settings";

interface CatalogStore {
	/** 扩展面板分段：浏览社区 / 已加载（进 store 保「切面板往返不丢 tab」） */
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
	/** 扩展更新检查结果（null = 未查；按 source 索引） */
	packageUpdates: Record<string, PackageUpdateInfo> | null;
	checkingUpdates: boolean;
	/** 检查已配置扩展的可用更新（只读） */
	checkUpdates: () => Promise<void>;
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

function createCatalogStore(environment: EnvironmentRef) {
	return create<CatalogStore>((set, get) => {
		/** 目录搜索防抖（query/type 变更 300ms 后触发） */
		let catalogDebounceTimer: ReturnType<typeof setTimeout> | undefined;
		const scheduleCatalogSearch = () => {
			clearTimeout(catalogDebounceTimer);
			catalogDebounceTimer = setTimeout(() => void get().searchCatalog(false), 300);
		};

		return {
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
			packageUpdates: null,
			checkingUpdates: false,

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
					const result = await getExecutionApi(environment).searchCatalog({
						query: catalogQuery,
						type: catalogType,
						page,
					});
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
					await getExecutionApi(environment).installPackage({ name });
					await get().refreshConfiguredPackages();
					// backend reload后刷新模型域与已加载资源，不读取general/LAN。
					void getSettingsStore(environment).getState().refreshAfterMutation("packages");
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
					const configured = await getExecutionApi(environment).listConfiguredPackages();
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
					await getExecutionApi(environment).removePackage({ source, scope });
					await get().refreshConfiguredPackages();
					// backend reload后刷新模型域与已加载资源，不读取general/LAN。
					void getSettingsStore(environment).getState().refreshAfterMutation("packages");
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
			checkUpdates: async () => {
				set({ checkingUpdates: true });
				try {
					const list = await getExecutionApi(environment).checkPackageUpdates();
					set({
						packageUpdates: Object.fromEntries(list.map((u) => [u.source, u])),
						checkingUpdates: false,
					});
				} catch {
					// 查不到（离线/超时）就当作没有更新信息，不打断面板
					set({ checkingUpdates: false });
				}
			},
		};
	});
}

const stores = new Map<string, ReturnType<typeof createCatalogStore>>();
export function getCatalogStore(reference: EnvironmentRef = LOCAL_ENVIRONMENT) {
	const environment = environmentRef(reference);
	const key = environmentKey(environment);
	let store = stores.get(key);
	if (!store) {
		store = createCatalogStore(environment);
		stores.set(key, store);
	}
	return store;
}
const localStore = getCatalogStore();
export const useLocalCatalogStore = localStore;
function useBoundCatalogStore<T = CatalogStore>(selector?: (state: CatalogStore) => T): T {
	const store = getCatalogStore(useEnvironment());
	return useStore(store, selector ?? ((state) => state as unknown as T));
}
// Static access is the local compatibility entry. Environment operations use getCatalogStore(ref).
export const useCatalogStore = Object.assign(useBoundCatalogStore, localStore);
