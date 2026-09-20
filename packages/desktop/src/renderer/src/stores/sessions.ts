import type { AvailableModel, PermissionMode, SessionMeta } from "@percho/shared";
import { messagesToUIMessages } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { errText } from "../lib/error-text";
import { clampThinkingLevel } from "../lib/thinking";
import { COMPOSER_FOCUS_EVENT, useDraftStore } from "./drafts";
import { pushToast } from "./toasts";
import { useTranscriptStore } from "./transcript";
import { useUiPreferencesStore } from "./ui-preferences";

/** 草稿会话 id 前缀：新会话 tab 的占位条目，只存在于 renderer 内存，后端永远不会看到 */
export const DRAFT_SESSION_PREFIX = "draft:";

export function isDraftSessionId(sessionId: string | null | undefined): boolean {
	return typeof sessionId === "string" && sessionId.startsWith(DRAFT_SESSION_PREFIX);
}

/**
 * 顶栏展示顺序：置顶分区在左（内部保持既有顺序，可拖动互换），其余按原顺序跟在后面。
 * 稳定分区而非排序：拖拽只改 tabs.json 的原始顺序，置顶区与非置顶区的相对位置由本函数表达。
 * 未知 id（会话已被外部删除）直接忽略。
 */
export function partitionSessionsByPin(
	sessions: SessionMeta[],
	pinnedSessions: readonly string[],
): SessionMeta[] {
	if (pinnedSessions.length === 0) return sessions;
	const pinned = new Set(pinnedSessions);
	const pinnedList = sessions.filter((s) => pinned.has(s.sessionId));
	if (pinnedList.length === 0) return sessions;
	return [...pinnedList, ...sessions.filter((s) => !pinned.has(s.sessionId))];
}

/**
 * 顶栏展示集（v8 定稿）：**置顶表驱动**——顶栏胶囊 = 置顶的会话（不管它的 tab 开没开）+ 未命名的 draft。
 * 用户：顶栏之前是「打开的会话全进去」= 唯一的会话总表，胶囊越来越多；现在左栏承担总表，
 * 顶栏只放真正需要盯的会话。
 * - **不能只从 tabs 里筛**：会话被置顶、但 tab 已关（或本次启动没恢复）时，只筛 tabs 会把它藏掉，
 *   用户会看到「已置顶却不在顶栏」——所以置顶会话的 meta 从 tabs → 历史两边找，点击时自动开。
 * - 顺序 = `pinnedSessions` 自己的顺序（置顶即插队到最左，拖动排序改的也是它）。
 * - **draft 例外**：未命名的新会话还没落盘、左栏历史里也查不到，不展示就彻底没地方能表示它；
 *   发出首条消息转正后它就离开顶栏（要留在顶栏则置顶）。
 * - 置顶表里查不到 meta 的 id（会话已删）直接跳过，不生成空胶囊。
 */
export function selectBarSessions(
	tabs: readonly SessionMeta[],
	pinnedSessions: readonly string[],
	history: readonly SessionMeta[],
): SessionMeta[] {
	const byId = new Map<string, SessionMeta>();
	for (const s of history) byId.set(s.sessionId, s);
	// tabs 覆盖历史同名项：名称/状态以当前打开实例为准
	for (const s of tabs) byId.set(s.sessionId, s);
	const pinned = pinnedSessions.map((id) => byId.get(id)).filter((s): s is SessionMeta => s !== undefined);
	const pinnedSet = new Set(pinnedSessions);
	const drafts = tabs.filter((s) => isDraftSessionId(s.sessionId) && !pinnedSet.has(s.sessionId));
	return [...pinned, ...drafts];
}

/**
 * 打开会话时同步四件套：消息历史（可选跳过 live 态）、排队队列、todo 面板、权限模式。
 * 取数并行（各写 store 不同字段，无交叉读），应用顺序保持 history → queue → todos。
 * 权限模式对齐后端真值：关 tab 重开后端已归零 default，拉回防 stale（spec permission-mode D1）。
 */
async function loadSessionBundle(sessionId: string, opts?: { skipHistoryIfLive?: boolean }): Promise<void> {
	// skip 判定在入口一次性取值：并行发起 IPC 前先确定是否跳过历史（agent 运行中保流式态，见 openFromHistory 注释）
	const skipHistory =
		opts?.skipHistoryIfLive === true &&
		useTranscriptStore.getState().bySession[sessionId]?.agentActive === true;
	const [history, followUpQueue, todos, permissionMode] = await Promise.all([
		skipHistory ? Promise.resolve(null) : getPi().getSessionMessages({ sessionId }),
		getPi().getFollowUpMessages({ sessionId }),
		getPi().getTodos({ sessionId }),
		getPi().getPermissionMode({ sessionId }),
	]);
	// TOCTOU 复核：await 期间会话转为 live（如恰好有 prompt 竞态）时丢弃迟到历史，
	// 防旧快照覆盖刚建立的流式态（queue/todo/permissionMode 是幂等快照，照常应用）
	const liveNow = useTranscriptStore.getState().bySession[sessionId]?.agentActive === true;
	const t = useTranscriptStore.getState();
	if (history && !liveNow) t.loadHistory(sessionId, messagesToUIMessages(history));
	t.setFollowUpQueue(sessionId, followUpQueue);
	t.loadTodos(sessionId, todos);
	applyBackendPermissionMode(sessionId, permissionMode);
}

/** 后端真值写入本 map（default = 删 key，保持「缺 key = default」语义） */
function applyBackendPermissionMode(sessionId: string, mode: PermissionMode): void {
	useSessionsStore.setState((state) => ({
		permissionModes: withPermissionMode(state.permissionModes, sessionId, mode),
	}));
}

/**
 * 权限模式 map 变异 helper（D4）：default = 删 key 的「缺 key = default」语义单点化，
 * 应用/乐观写入/回滚/会话销毁四处共用。
 */
function withPermissionMode(
	map: Record<string, PermissionMode>,
	sessionId: string,
	mode: PermissionMode,
): Record<string, PermissionMode> {
	const next = { ...map };
	if (mode === "default") delete next[sessionId];
	else next[sessionId] = mode;
	return next;
}

/**
 * 乐观会话设置骨架（D4，setCurrentModel/setThinkingLevel 共用）：
 * 快照 → 乐观写（跟随字段 + 当前会话条目 + ui-state 持久化）→ 真实会话 IPC 同步 →
 * 失败整体回滚（乐观态 + ui-state 重新持久化）+ toast。draft 无后端会话：只记跟随值，创建时生效。
 */
async function optimisticSessionSetting(
	label: string,
	toastKey: "toast.modelSwitchFailed" | "toast.thinkingSwitchFailed",
	compute: () => {
		/** 乐观写入的跟随字段（lastUsedModel / lastUsedThinkingLevel） */
		global: { lastUsedModel?: { provider: string; modelId: string } | null; lastUsedThinkingLevel?: string };
		/** 乐观写入当前会话条目的补丁（model / thinkingLevel） */
		sessionPatch: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null };
		/** saveUiState 载荷（乐观与回滚各一次） */
		uiState: { lastUsedModel?: { provider: string; modelId: string } | null; lastUsedThinkingLevel?: string };
		/** 真实会话的 SDK 同步 */
		sync: (sessionId: string) => Promise<void>;
	},
): Promise<void> {
	const s = useSessionsStore.getState();
	const { activeSessionId } = s;
	const previousGlobal = {
		lastUsedModel: s.lastUsedModel,
		lastUsedThinkingLevel: s.lastUsedThinkingLevel,
	};
	const previousSession = s.sessions.find((x) => x.sessionId === activeSessionId);
	const { global, sessionPatch, uiState, sync } = compute();
	const apply = (
		g: { lastUsedModel?: { provider: string; modelId: string } | null; lastUsedThinkingLevel?: string },
		patch: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null },
	) =>
		useSessionsStore.setState((state) => ({
			...g,
			sessions: state.sessions.map((x) => (x.sessionId === activeSessionId ? { ...x, ...patch } : x)),
		}));
	apply(global, sessionPatch);
	getPi()
		.saveUiState({ state: uiState })
		.catch((error) => {
			console.error("ui-state 持久化失败", error);
			pushToast("warning", "toast.uiStateSaveFailed", errText(error));
		});
	// draft 无后端会话：选择只记为跟随值，创建时随 createSession 生效
	if (activeSessionId && !isDraftSessionId(activeSessionId)) {
		try {
			await sync(activeSessionId);
		} catch (error) {
			// SDK 同步失败（如凭证缺失/模型不可用）：回滚乐观态 + 重新持久化 + toast
			apply(
				previousGlobal,
				previousSession
					? { model: previousSession.model, thinkingLevel: previousSession.thinkingLevel }
					: { model: null, thinkingLevel: null },
			);
			getPi()
				.saveUiState({ state: previousGlobal })
				.catch((e) => console.error("ui-state 回滚持久化失败", e));
			console.error(`${label}失败`, error);
			pushToast("warning", toastKey, errText(error));
		}
	}
}

/**
 * 记住「上次项目目录」（重启后启动页预填，用户不用重选项目）。
 * 只写 cwd、**不恢复任何会话**（v10 启动纯空不变）；同值短路，避免切会话时频繁写 ui-state。
 * 三个调用点 = 新建会话（发首条消息转正）/ 切会话 / 从历史打开，即「用户当前真的在用哪个项目」。
 */
function rememberCwd(cwd: string | null): void {
	if (!cwd) return;
	useUiPreferencesStore.getState().setLastCwd(cwd);
}

/** 顶栏打开的会话持久化（重启恢复用）；由主进程写 userData/tabs.json，不依赖 renderer localStorage */
interface SessionsStore {
	sessions: SessionMeta[];
	activeSessionId: string | null;
	cwd: string | null;
	models: AvailableModel[];
	/** 上次使用的模型/思考深度（新会话与 draft 起步跟随；持久化 ui-state.json，语义 = 跟随最近选择，非独立默认设置） */
	lastUsedModel: { provider: string; modelId: string } | null;
	lastUsedThinkingLevel: string;
	/** 项目信任决策完成计数：ensureProjectTrust 应答后 +1，驱动 draft 斜杠菜单按新决策重拉 */
	trustVersion: number;
	/** 按会话权限模式（缺 key = default；draft id 为 key 的条目是 renderer 内存态，转正时由 ensureSession 应用到后端） */
	permissionModes: Record<string, PermissionMode>;
	createSession: (cwd?: string, replaceDraftId?: string) => Promise<void>;
	/** 新建草稿会话 tab：不触后端、不落盘（空 tab 重启后自动消失），发送首条消息时才用其 cwd 真正创建 */
	createDraftSession: (cwd?: string) => void;
	/** 设置新会话的目标项目目录；活跃 tab 是 draft 时同步更新其条目（切 tab 往返不丢选择） */
	setDraftCwd: (cwd: string) => void;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string) => Promise<void>;
	openFromHistory: (filePath: string) => Promise<void>;
	/** 在指定 assistant 消息处分叉：新会话以新 tab 打开并切换过去（原会话保留原样）；成功返回新 sessionId */
	forkSession: (ref: { entryId?: string; text?: string }) => Promise<string | undefined>;
	/** 撤回一条用户消息：会话回退到该消息之前，文本/图片放回输入框草稿继续编辑 */
	recallMessage: (ref: { entryId?: string; text?: string; timestamp?: number }) => Promise<void>;
	/** 自动命名等事件带来的标题变更 */
	updateSessionName: (sessionId: string, name: string | undefined) => void;
	pickDirectory: () => Promise<void>;
	loadModels: () => Promise<void>;
	setCurrentModel: (provider: string, modelId: string) => Promise<void>;
	setThinkingLevel: (level: string) => Promise<void>;
	/** 切换会话权限模式（draft 态仅本地；真实会话乐观更新 + 失败回滚 + toast） */
	setSessionPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<void>;
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
	sessions: [],
	activeSessionId: null,
	cwd: null,
	models: [],
	lastUsedModel: null,
	lastUsedThinkingLevel: "medium",
	trustVersion: 0,
	permissionModes: {},

	createSession: async (cwd, replaceDraftId) => {
		const targetCwd = cwd ?? get().cwd;
		if (!targetCwd) return;
		try {
			const meta = await getPi().createSession({
				options: {
					cwd: targetCwd,
					...get().lastUsedModel,
					thinkingLevel: get().lastUsedThinkingLevel,
				},
			});
			set((state) => ({
				// draft 转正式会话：原地替换保持 tab 位置；普通新建则追加
				sessions: replaceDraftId
					? state.sessions.map((s) => (s.sessionId === replaceDraftId ? meta : s))
					: [...state.sessions, meta],
				activeSessionId: meta.sessionId,
				cwd: targetCwd,
				// draft 键下的权限模式由 ensureSession 在创建后应用到新 id，这里顺手满档防泄漏
				permissionModes: replaceDraftId
					? withPermissionMode(state.permissionModes, replaceDraftId, "default")
					: state.permissionModes,
			}));
			useTranscriptStore.getState().resetSession(meta.sessionId);
			rememberCwd(targetCwd);
		} catch (error) {
			// 失败时 draft tab 保留，用户重试即可；toast 提示（非会话内容，不残留）
			console.error("创建会话失败", error);
			pushToast("warning", "toast.sessionCreateFailed", errText(error));
		}
	},

	createDraftSession: (cwd) => {
		const targetCwd = cwd ?? get().cwd;
		if (!targetCwd) return;
		// 信任前置：未决项目立即弹窗（结果落 trust.json），draft 拉斜杠命令/转正建会话直接命中缓存
		void getPi()
			.ensureProjectTrust({ cwd: targetCwd })
			.then(() => set((s) => ({ trustVersion: s.trustVersion + 1 })))
			.catch((error) => {
				console.error("项目信任检查失败", error);
				pushToast("warning", "toast.trustFailed", errText(error));
			});
		const now = Date.now();
		const draft: SessionMeta = {
			sessionId: `${DRAFT_SESSION_PREFIX}${crypto.randomUUID()}`,
			cwd: targetCwd,
			model: get().lastUsedModel,
			thinkingLevel: get().lastUsedThinkingLevel,
			active: true,
			messageCount: 0,
			createdAt: now,
			modifiedAt: now,
		};
		set((state) => ({
			sessions: [...state.sessions, draft],
			activeSessionId: draft.sessionId,
			cwd: targetCwd,
		}));
	},

	setDraftCwd: (cwd) => {
		// 同 createDraftSession：cwd 变化即前置信任决策
		void getPi()
			.ensureProjectTrust({ cwd })
			.then(() => set((s) => ({ trustVersion: s.trustVersion + 1 })))
			.catch((error) => {
				console.error("项目信任检查失败", error);
				pushToast("warning", "toast.trustFailed", errText(error));
			});
		set((state) => {
			const active = state.sessions.find((s) => s.sessionId === state.activeSessionId);
			if (active && isDraftSessionId(active.sessionId)) {
				return {
					cwd,
					sessions: state.sessions.map((s) => (s.sessionId === active.sessionId ? { ...s, cwd } : s)),
				};
			}
			return { cwd };
		});
	},

	switchSession: (sessionId) => {
		set((state) => {
			const session = state.sessions.find((s) => s.sessionId === sessionId);
			return { activeSessionId: sessionId, cwd: session?.cwd ?? state.cwd };
		});
		// 懒加载兜底（D4）：目标会话无 transcript 数据时补拉四件套（从历史打开、
		// 事件桥断连期间的切换等都经此路径自愈；已有数据零成本短路）
		if (!isDraftSessionId(sessionId) && useTranscriptStore.getState().bySession[sessionId] === undefined) {
			void loadSessionBundle(sessionId).catch((error) => {
				console.error("切换会话时补拉数据失败", error);
				pushToast("warning", "toast.sessionOpenFailed", errText(error));
			});
		}
		rememberCwd(get().cwd);
		// 切到 draft 不落盘：tabs.json 保持指向最近的真实会话（draft 重启后本就会消失）
	},

	updateSessionName: (sessionId, name) =>
		set((state) => ({
			sessions: state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s)),
		})),

	closeSession: async (sessionId) => {
		const isDraft = isDraftSessionId(sessionId);
		// draft 没有后端会话，纯本地移除
		if (!isDraft) {
			try {
				await getPi().closeSession({ sessionId });
			} catch (error) {
				// 会话关闭失败：UI 状态保留（用户可重试），显形不静默（曾「点了没反应」）
				console.error("关闭会话失败", error);
				pushToast("warning", "toast.closeFailed", errText(error));
				return;
			}
		}
		useTranscriptStore.getState().resetSession(sessionId);
		set((state) => {
			const sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
			const activeSessionId =
				state.activeSessionId === sessionId ? (sessions[0]?.sessionId ?? null) : state.activeSessionId;
			// 切 active 后 cwd 同步到新活跃会话的项目（否则跨项目关会话后 cwd 残留旧项目，新建会话归属错）（B5）
			const cwd = activeSessionId
				? (sessions.find((s) => s.sessionId === activeSessionId)?.cwd ?? state.cwd)
				: state.cwd;
			// 权限模式随会话销毁归零（后端 holder 同点位清理；draft 态本就纯 renderer）
			const permissionModes = withPermissionMode(state.permissionModes, sessionId, "default");
			return { sessions, activeSessionId, cwd, permissionModes };
		});
	},

	openFromHistory: async (filePath) => {
		try {
			const meta = await getPi().openSession({ filePath });
			set((state) => ({
				sessions: [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta],
				activeSessionId: meta.sessionId,
				cwd: meta.cwd,
			}));
			// 先记 cwd 再拉数据：即便随后装载失败（下面的 catch），用户「在用哪个项目」的事实也已经成立
			rememberCwd(meta.cwd);
			// 运行中子会话的事件已按其 sessionId 实时转发；保留已有流式态，
			// 否则会在点击卡片时把 agent_start 建立的进度视图重置为静态历史。
			await loadSessionBundle(meta.sessionId, { skipHistoryIfLive: true });
		} catch (error) {
			console.error("打开会话失败", error);
			pushToast("warning", "toast.sessionOpenFailed", errText(error));
		}
	},

	forkSession: async (ref) => {
		const { activeSessionId } = get();
		// draft 还没有消息，无可分叉（UI 上也到不了这里，防御性拦截）
		if (!activeSessionId || isDraftSessionId(activeSessionId)) return undefined;
		try {
			const meta = await getPi().forkSession({ sessionId: activeSessionId, ref });
			set((state) => ({
				sessions: [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta],
				activeSessionId: meta.sessionId,
			}));
			await loadSessionBundle(meta.sessionId);
			return meta.sessionId;
		} catch (error) {
			console.error("分叉会话失败", error);
			pushToast("warning", "toast.forkFailed", errText(error));
			return undefined;
		}
	},

	recallMessage: async (ref) => {
		const { activeSessionId } = get();
		// draft 还没有消息，无可撤回（UI 上也到不了这里，防御性拦截）
		if (!activeSessionId || isDraftSessionId(activeSessionId)) return;
		try {
			const recalled = await getPi().recallMessage({ sessionId: activeSessionId, ref });
			// 内容回填草稿：已有草稿文本时换行拼接（与排队取回一致），图片追加在尾部
			useDraftStore.getState().updateDraft(activeSessionId, (d) => ({
				...d,
				text: d.text ? `${d.text}\n${recalled.text}` : recalled.text,
				images: recalled.images.length > 0 ? [...d.images, ...recalled.images] : d.images,
			}));
			// 重建消息流 + 队列/todo 对齐（同 fork 的恢复套路；会话 meta 不变无需更新）
			await loadSessionBundle(activeSessionId);
			window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT));
		} catch (error) {
			console.error("撤回消息失败", error);
			pushToast("warning", "toast.recallFailed", errText(error));
		}
	},

	pickDirectory: async () => {
		const cwd = await getPi().pickDirectory();
		// 走 setDraftCwd：活跃 tab 是 draft 时同步更新其条目
		if (cwd) get().setDraftCwd(cwd);
	},

	loadModels: async () => {
		try {
			const models = await getPi().listModels();
			// 复用上次使用的模型/思考级别（失效则回退到第一个可用模型）
			const saved = await getPi().loadUiState();
			const savedModel =
				saved?.lastUsedModel &&
				models.some(
					(m) => m.provider === saved.lastUsedModel?.provider && m.id === saved.lastUsedModel?.modelId,
				)
					? saved.lastUsedModel
					: null;
			const current = get().lastUsedModel;
			const fallback = models.find((m) => m.authed) ?? models[0];
			const nextLastUsedModel =
				savedModel ?? current ?? (fallback ? { provider: fallback.provider, modelId: fallback.id } : null);
			// 持久化级别也按当前选中模型的能力夹紧（避免恢复后 store 与 UI/SDK 实际生效值不一致）
			const nextModelRecord = nextLastUsedModel
				? models.find((m) => m.provider === nextLastUsedModel.provider && m.id === nextLastUsedModel.modelId)
				: undefined;
			const supportedLevels = nextModelRecord?.thinkingLevels;
			const rawLevel = saved?.lastUsedThinkingLevel ?? get().lastUsedThinkingLevel;
			const clampedLevel =
				supportedLevels && supportedLevels.length > 0
					? clampThinkingLevel(rawLevel, supportedLevels)
					: rawLevel;
			set({
				models,
				lastUsedModel: nextLastUsedModel,
				lastUsedThinkingLevel: clampedLevel,
			});
		} catch (error) {
			console.error("加载模型列表失败", error);
			pushToast("warning", "toast.modelsLoadFailed", errText(error));
		}
	},

	/**
	 * 切换当前会话的模型：更新跟随记录（新会话起步用）+ 当前会话（只影响该会话），并同步 SDK。
	 * 乐观更新，SDK 同步失败回滚 + toast（范式同 setSessionPermissionMode）——
	 * 动作反馈属 toast，不进会话错误卡、不跨会话残留。
	 */
	setCurrentModel: async (provider, modelId) => {
		// 思考深度跟随新模型能力收缩（就近向上找，找不到再取最高档，与 UI 一致）
		const state = get();
		const nextModel = state.models.find((m) => m.provider === provider && m.id === modelId);
		let thinkingLevel = state.lastUsedThinkingLevel;
		if (nextModel?.thinkingLevels && nextModel.thinkingLevels.length > 0) {
			thinkingLevel = clampThinkingLevel(thinkingLevel, nextModel.thinkingLevels);
		}
		await optimisticSessionSetting("切换模型", "toast.modelSwitchFailed", () => ({
			global: { lastUsedModel: { provider, modelId }, lastUsedThinkingLevel: thinkingLevel },
			sessionPatch: { model: { provider, modelId }, thinkingLevel },
			uiState: { lastUsedModel: { provider, modelId }, lastUsedThinkingLevel: thinkingLevel },
			sync: (sessionId) => getPi().setModel({ sessionId, provider, modelId }),
		}));
	},

	/** 切换当前会话的思考深度：更新跟随记录 + 当前会话（只影响该会话），并同步 SDK（失败回滚 + toast） */
	setThinkingLevel: async (level) => {
		await optimisticSessionSetting("切换思考深度", "toast.thinkingSwitchFailed", () => ({
			global: { lastUsedThinkingLevel: level },
			sessionPatch: { thinkingLevel: level },
			uiState: { lastUsedThinkingLevel: level },
			sync: (sessionId) => getPi().setThinkingLevel({ sessionId, level }),
		}));
	},

	/**
	 * 切换会话权限模式：draft 态纯 renderer 内存（转正时 ensureSession 应用到后端）；
	 * 真实会话乐观更新 + IPC 同步，失败回滚 + toast（范式同 setContextManagerMode）。
	 * 后端为内存态即时生效（每次 tool_call 实时读），无需重升会话。
	 */
	setSessionPermissionMode: async (sessionId, mode) => {
		if (isDraftSessionId(sessionId)) {
			set((state) => ({ permissionModes: withPermissionMode(state.permissionModes, sessionId, mode) }));
			return;
		}
		const previous = get().permissionModes[sessionId] ?? "default";
		set((state) => ({ permissionModes: withPermissionMode(state.permissionModes, sessionId, mode) }));
		try {
			await getPi().setPermissionMode({ sessionId, mode });
		} catch (error) {
			set((state) => ({ permissionModes: withPermissionMode(state.permissionModes, sessionId, previous) }));
			console.error("切换权限模式失败", error);
			pushToast("warning", "toast.permissionModeFailed", errText(error));
		}
	},
}));
