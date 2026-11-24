import type { CatalogPackage, CatalogPackageType, ConfiguredPackageInfo } from "@percho/shared";
import {
	type EnvironmentRef,
	environmentKey,
	environmentRef,
	LOCAL_ENVIRONMENT,
	npmSourceToPackageName,
	REMOTE_METHOD_UNSUPPORTED,
} from "@percho/shared";
import { create, useStore } from "zustand";
import { getExecutionApi } from "../environment-api";
import { useEnvironment } from "../environment-context";
import { getSettingsStore } from "./settings";

/** 单行更新结果；unchanged = 已是最新或 registry 不可达，unsupported = 旧版远程端 */
export type PackageUpdateOutcome =
	| { kind: "updated"; version: string; deferred?: number }
	| { kind: "unchanged" }
	| { kind: "unsupported" }
	| { kind: "error"; message: string };

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
	/** 更新中的 source 集合（含「全部更新」里排队等待的） */
	updatingSources: Record<string, true>;
	/** 按 source 的最近一次更新结果；错误与「版本未变」都留在该行展示 */
	updateResults: Record<string, PackageUpdateOutcome>;
	/** settings.json 已配置的包（null = 未加载；「已安装」态匹配/卸载用） */
	configuredPackages: ConfiguredPackageInfo[] | null;
	/** 本地清单所属会话；null 只查用户级配置。 */
	configuredSessionId: string | null;
	/** npm 最新版本按包名缓存，本地安装变更不使其失效。 */
	packageUpdates: Record<string, { latest: string; checkedAt: number }>;
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
	/** 原地更新一个已配置的 npm 包到 latest */
	updateConfiguredPackage: (source: string, scope: "user" | "project") => Promise<void>;
	/** 顺序更新给定的包；单个失败不影响其余，全部结束后统一刷新 */
	updatePackages: (targets: { source: string; scope: "user" | "project" }[]) => Promise<void>;
	refreshConfiguredPackages: (sessionId?: string | null) => Promise<void>;
}

function createCatalogStore(environment: EnvironmentRef) {
	return create<CatalogStore>((set, get) => {
		let configuredSeq = 0;
		let updatesRequest: { names: string[]; promise: Promise<void> } | undefined;
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
			updatingSources: {},
			updateResults: {},
			configuredPackages: null,
			configuredSessionId: null,
			packageUpdates: {},

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
					if (get().extensionsTab === "loaded") void get().checkUpdates();
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

			refreshConfiguredPackages: async (sessionId = get().configuredSessionId) => {
				const seq = ++configuredSeq;
				if (get().configuredSessionId !== sessionId) {
					set({ configuredSessionId: sessionId, configuredPackages: null });
				}
				try {
					const configured = await getExecutionApi(environment).listConfiguredPackages({
						sessionId: sessionId ?? undefined,
					});
					if (seq !== configuredSeq) return;
					set({ configuredPackages: configured });
				} catch {
					// 离线保留最后可信的本地版本；不把读取失败视作已卸载。
				}
			},

			removeConfiguredPackage: async (source, scope) => {
				const sessionId = get().configuredSessionId;
				set((state) => {
					const removeErrors = { ...state.removeErrors };
					delete removeErrors[source];
					return { removingSources: { ...state.removingSources, [source]: true }, removeErrors };
				});
				try {
					await getExecutionApi(environment).removePackage({
						source,
						scope,
						sessionId: sessionId ?? undefined,
					});
					await get().refreshConfiguredPackages();
					if (get().extensionsTab === "loaded") void get().checkUpdates();
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
			updateConfiguredPackage: (source, scope) => get().updatePackages([{ source, scope }]),
			updatePackages: async (targets) => {
				const queued = targets.filter(({ source }) => !Object.hasOwn(get().updatingSources, source));
				if (!queued.length) return;
				const sessionId = get().configuredSessionId;
				set((state) => {
					const updateResults = { ...state.updateResults };
					for (const { source } of queued) delete updateResults[source];
					return {
						updatingSources: {
							...state.updatingSources,
							...Object.fromEntries(queued.map(({ source }) => [source, true as const])),
						},
						updateResults,
					};
				});
				let changed = false;
				// 后端也串行化；这里顺序提交是为了逐行报告结果，并把重载压成末尾一次刷新
				for (const { source, scope } of queued) {
					let outcome: PackageUpdateOutcome;
					try {
						const result = await getExecutionApi(environment).updatePackage({
							source,
							scope,
							sessionId: sessionId ?? undefined,
						});
						const updated = Boolean(result.to && result.to !== result.from);
						changed ||= updated;
						outcome = updated
							? {
									kind: "updated",
									version: result.to as string,
									...(result.deferred ? { deferred: result.deferred } : {}),
								}
							: { kind: "unchanged" };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						outcome = message.includes(REMOTE_METHOD_UNSUPPORTED)
							? { kind: "unsupported" }
							: { kind: "error", message };
					}
					set((state) => {
						const updatingSources = { ...state.updatingSources };
						delete updatingSources[source];
						return { updatingSources, updateResults: { ...state.updateResults, [source]: outcome } };
					});
				}
				if (!changed) return;
				await get().refreshConfiguredPackages();
				// backend reload后刷新模型域与已加载资源，不读取general/LAN。
				void getSettingsStore(environment).getState().refreshAfterMutation("packages");
			},
			checkUpdates: async () => {
				const names = [
					...new Set(
						(get().configuredPackages ?? []).flatMap((p) => {
							const name = npmSourceToPackageName(p.source);
							return name ? [name] : [];
						}),
					),
				].filter((name) => {
					const updates = get().packageUpdates;
					const cached = Object.hasOwn(updates, name) ? updates[name] : undefined;
					return !cached || Date.now() - cached.checkedAt >= 5 * 60_000;
				});
				if (!names.length) return;
				if (updatesRequest) {
					const pending = updatesRequest;
					await pending.promise;
					// 同一批失败不立即重试；新项目或新安装的包接在当前请求之后查询。
					if (names.some((name) => !pending.names.includes(name))) await get().checkUpdates();
					return;
				}
				const request = Promise.resolve().then(async () => {
					try {
						const list = await getExecutionApi(environment).checkPackageUpdates({ names });
						const checkedAt = Date.now();
						const entries = list
							.filter((p) => p.latest)
							.map((p) => [p.name, { latest: p.latest, checkedAt }]);
						if (entries.length)
							set((s) => ({ packageUpdates: { ...s.packageUpdates, ...Object.fromEntries(entries) } }));
					} catch {
						// 查询失败不打断列表，下次进入面板时可重试。
					} finally {
						if (updatesRequest?.promise === request) updatesRequest = undefined;
					}
				});
				updatesRequest = { names, promise: request };
				return request;
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
