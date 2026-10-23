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
import { pushToast } from "./toasts";

export type SettingsCategory =
	| "general"
	| "appearance"
	| "models"
	| "network"
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
	loadPermissionGate: () => Promise<void>;
	refreshAfterMutation: (domain: "provider" | "packages") => Promise<void>;
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

/** 目录请求来源（产出快照的那次请求；仅用于诊断与断言） */
type CatalogSource = "local" | "network" | "mutation";

/** 目录请求载荷：**只有 providers**（子代理清单有自己的发布路径，见 `loadSubagents`） */
interface CatalogPayload {
	providers: ProviderInfo[];
	source?: CatalogSource;
}

/** Electron `invoke` 的失败信息带前缀（`Error invoking remote method '<channel>': Error: `），
 *  剥掉它只留后端原文 —— 表单校验提示（provider ID 非法 / 旧 provider 已改名 等）才读得懂 */
function errorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

/**
 * 模型目录（providers）请求协调器（spec D3；机制与反例见 `.local/agent-work/probe/phase0-design.md` §2）。
 *
 * 三条**独立**仲裁，别合并：
 * - **发布**：请求开始领全局号 `token`，`token > publishedSeq`（后开始者赢）**且** 该读取发出后没有发生写盘
 *   （`epochAtStart === mutationEpoch`）才发布。后半条是「变更后的重读语义」的关键：写盘前发出的读取，
 *   无论多晚回、多成功都不能发布，否则刚删掉的 provider 会复活。
 * - **error**：只有结算时仍是全局最新号（`token === seq`）的请求写 —— 旧请求的成败不得覆盖新请求的结论。
 * - **spinner**：按类别（local=loading / network=refreshing）记在途号，只有该类别的**最新**请求有资格清。
 *   跨类别互不干扰（否则「本地在途 + 联网先结束」会让 loading 永久卡住）；同类别并发时（见下）旧请求也不清。
 *
 * 刻意**不采用**「失败也占位（已结算号水位）」的规则：那会让「首次打开面板 + 联网立刻失败」时本地读取被一并拒掉，
 * 面板空列表。代价是「同一写盘世代下，较老的成功读取可以兜底发布」。
 */
function createCatalogCoordinator(deps: {
	load: (kind: "local" | "network") => Promise<CatalogPayload>;
	publish: (payload: CatalogPayload) => void;
	setFlags: (flags: { loading?: boolean; refreshing?: boolean; error?: string | null }) => void;
}) {
	type Kind = "local" | "network";
	/** `token` = 该次请求的全局号：多个入口 await 同一个在途请求时，调用方靠它去重「每个有效发布只做一次副作用」 */
	type Result = { published: boolean; token: number };
	let seq = 0;
	let publishedSeq = 0;
	const kindSeq: Record<Kind, number> = { local: 0, network: 0 };
	let mutationEpoch = 0;
	let localInFlight: { epoch: number; promise: Promise<Result> } | null = null;
	let networkInFlight: Promise<Result> | null = null;

	const setSpinner = (kind: Kind, on: boolean) =>
		deps.setFlags(kind === "network" ? { refreshing: on } : { loading: on });

	const run = async (kind: Kind, source: CatalogSource): Promise<Result> => {
		const token = ++seq;
		const kindToken = ++kindSeq[kind];
		const epochAtStart = mutationEpoch;
		setSpinner(kind, true);
		deps.setFlags({ error: null }); // 新请求开始即清旧错误（结论由最新请求负责）
		try {
			const payload = await deps.load(kind);
			if (token > publishedSeq && epochAtStart === mutationEpoch) {
				publishedSeq = token;
				deps.publish({ ...payload, source });
				return { published: true, token };
			}
			// 否则丢弃：要么已有更晚发出的结果落地，要么本快照可能早于某次写盘（不能复活旧数据）
			return { published: false, token };
		} catch (error) {
			// 失败不发布：保留最后一次成功发布的快照（可能已过期），由 error 提示用户重试
			if (token === seq) deps.setFlags({ error: errorMessage(error) });
			return { published: false, token };
		} finally {
			if (kindToken === kindSeq[kind]) setSpinner(kind, false);
		}
	};

	const startLocal = (source: CatalogSource): Promise<Result> => {
		const promise = run("local", source).finally(() => {
			if (localInFlight && localInFlight.promise === promise) localInFlight = null;
		});
		localInFlight = { epoch: mutationEpoch, promise };
		return promise;
	};

	return {
		/** 面板加载 / 分类切换：同一写盘世代下的在途读取可复用（single-flight） */
		refreshLocal(): Promise<Result> {
			const current = localInFlight;
			if (current && current.epoch === mutationEpoch) return current.promise;
			return startLocal("local");
		},
		/**
		 * 写盘成功后调用（**必须**读到写盘后的状态）：推进写盘世代 ⇒ 写盘前发出的读取一律不复用，
		 * 一定新发一次读取。调用方须保证此刻写盘 IPC 已 resolve（后端各变更最后一步 `refreshLocalModels()`
		 * 在 resolve 之前完成，见 `backend/src/settings/settings.ts`）。
		 */
		refreshAfterMutation(): Promise<Result> {
			mutationEpoch += 1;
			return startLocal("mutation");
		},
		/** 联网刷新（自动入口 + 手动入口共用，single-flight） */
		refreshNetwork(): Promise<Result> {
			if (networkInFlight) return networkInFlight;
			const promise = run("network", "network").finally(() => {
				if (networkInFlight === promise) networkInFlight = null;
			});
			networkInFlight = promise;
			return promise;
		},
	};
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

	/** 变更后刷新 provider 列表与模型选择器数据（目录重读必须推进写盘世代，见协调器 `refreshAfterMutation`） */
	const afterMutation = () => get().refreshAfterMutation("provider");

	/** 上一次触发过「选择器刷新」的目录请求号（同一在途请求的多个入口只刷一次） */
	let selectorRefreshToken = 0;

	/** 目录（providers）走协调器：谁多发谁发、谁后开始谁赢，都在里面仲裁 */
	const coordinator = createCatalogCoordinator({
		load: async (kind) =>
			kind === "network"
				? { providers: await getPi().listProviders({ options: { forceNetwork: true } }) }
				: { providers: await getPi().listProviders({}) },
		publish: ({ providers }) => set({ providers }),
		setFlags: (flags) => set(flags),
	});

	/**
	 * 子代理清单：**独立于目录请求**的轻量发布路径（review R3）。
	 * - network 请求根本不返回子代理清单 ⇒ 联网成功没有理由淘汰本地清单；
	 * - 只接受「最新一次子代理读取」的结果（自己的序号，乱序不回灌旧清单）；
	 * - 读失败只发 toast，既不挡目录发布，也不去抢目录的 `error` 字段。
	 */
	let subagentsSeq = 0;
	const loadSubagents = async (): Promise<void> => {
		const token = ++subagentsSeq;
		try {
			const subagents = await getPi().listSubagents();
			if (token === subagentsSeq) set({ subagents });
		} catch (error) {
			pushToast("warning", "toast.subagentsLoadFailed", errorMessage(error));
		}
	};

	/** 已加载资源（skills/extensions）：顺序上排在目录之后（沿用改造前后顺序），失败走 toast —— 既不污染目录 error 仲裁，也不静默 */
	const loadLoadedResources = async (): Promise<void> => {
		const activeSessionId = useSessionsStore.getState().activeSessionId;
		if (!activeSessionId) {
			set({ skills: null, skillDiagnostics: [], extensions: null, extensionErrors: [] });
			return;
		}
		try {
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
		} catch (error) {
			pushToast("warning", "toast.loadedResourcesFailed", errorMessage(error));
		}
	};

	/**
	 * 面板数据装载。目录（providers/subagents）经协调器仲裁（loading/error/发布都在里面）；
	 * 其余本地配置/偏好/资源各自独立发布 —— 不得因为目录请求被拒而丢字段。
	 */
	let permissionFlight: Promise<void> | null = null;
	const loadPermissionGate = (): Promise<void> => {
		if (permissionFlight) return permissionFlight;
		const work = getPi()
			.getPermissionConfig()
			.then((permission) => {
				set({ permissionGateOff: !permission.enabled });
			})
			.catch(() => {})
			.finally(() => {
				if (permissionFlight === work) permissionFlight = null;
			});
		permissionFlight = work;
		return work;
	};
	const loadGeneral = (): void => {
		void getPi()
			.getContextManagerConfig()
			.then((cm) => set({ contextManagerMode: cm.mode }))
			.catch(() => {});
		void getPi()
			.getChannelWatchConfig()
			.then((cw) => set({ channelWatchEnabled: cw.enabled }))
			.catch(() => {});
	};
	const loadModelsData = async (mode: "local" | "mutation"): Promise<void> => {
		void readPrefs().catch((error) =>
			pushToast("warning", "toast.modelPrefsLoadFailed", errorMessage(error)),
		);
		await Promise.all([
			mode === "mutation" ? coordinator.refreshAfterMutation() : coordinator.refreshLocal(),
			loadSubagents(),
		]);
	};
	const loadPanel = (category: SettingsCategory): void => {
		switch (category) {
			case "general":
				loadGeneral();
				break;
			case "models":
				void loadModelsData("local");
				break;
			case "skills":
			case "extensions":
				void loadLoadedResources();
				break;
			case "lan":
				void get().refreshLanStatus();
				break;
			case "appearance":
			case "network":
			case "mcp":
			case "about":
				break;
			default:
				void get().refresh();
		}
	};
	const loadFullData = async (): Promise<void> => {
		// 权限门控配置是本地文件读，独立加载，不被 provider 列表阻塞
		// （仅派生 enabled=false 逃生舱态供 chip 禁用提示；开关 UI 已撒，spec permission-mode D7）
		void loadPermissionGate();
		loadGeneral();
		// Full-refresh's historical silent LAN read must not take over the catalog error field.
		void getPi()
			.lanGetStatus()
			.then((lanStatus) => set({ lanStatus }))
			.catch(() => {});
		await loadModelsData("local");
		// 已加载资源：顺序排在目录之后（沿用改造前顺序）；目录失败也照取
		await loadLoadedResources();
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
			const wasOpen = get().open;
			set({ open, testResults: {}, error: null });
			if (open && !wasOpen) {
				void loadPermissionGate();
				loadPanel(get().category);
			}
		},

		openWith: (category) => {
			const previous = get();
			const target = category ?? previous.category;
			set({ category: target, open: true, testResults: {}, error: null });
			if (!previous.open) void loadPermissionGate();
			if (!previous.open || previous.category !== target) loadPanel(target);
		},

		setCategory: (category) => {
			if (get().category === category) return;
			set({ category });
			if (get().open) loadPanel(category);
		},
		loadPermissionGate,
		refreshAfterMutation: async (domain) => {
			await loadModelsData("mutation");
			if (domain === "packages") await loadLoadedResources();
			await useSessionsStore.getState().loadModels();
		},

		refresh: async () => {
			// 目录走协调器（loading/error/发布都受仲裁）；prefs/subagents/资源各自独立发布
			await loadFullData();
		},

		refreshProvidersFromNetwork: async () => {
			const { published, token } = await coordinator.refreshNetwork();
			// runtime 已持有最新目录，本地刷新模型选择器数据即可；
			// 只有**真的发布了新目录**才刷新 Composer 的模型选择器（被拒的旧结果不触发副作用，见 spec D3）；
			// 同一在途请求被多个入口 await（进入分类自动 + 手动点击）时按请求号去重，只刷一次。
			if (!published || token === selectorRefreshToken) return;
			selectorRefreshToken = token;
			await useSessionsStore.getState().loadModels();
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
