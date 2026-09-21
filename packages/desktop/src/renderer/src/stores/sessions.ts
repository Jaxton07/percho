import type { AvailableModel, PermissionMode, SessionCloseIntent, SessionMeta } from "@percho/shared";
import { messagesToUIMessages } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { errText } from "../lib/error-text";
import { isPrimaryNavigationSession } from "../lib/session-visibility";
import { clampThinkingLevel } from "../lib/thinking";
import { COMPOSER_FOCUS_EVENT, useDraftStore } from "./drafts";
import { pushToast } from "./toasts";
import { useTranscriptStore } from "./transcript";
import { useUiPreferencesStore } from "./ui-preferences";

/**
 * 新会话 draft（renderer 全局唯一编辑态，spec §5.1）：**不进 `sessions`、不落盘、不触后端**。
 * 整个 renderer 最多一份，`activeSessionId === null` 时它就是当前页面；首条消息 promotion 时
 * 用这份快照建真实会话（快照优先于全局「最近使用」值）。
 */
export interface NewSessionDraftConfig {
	/** 目标项目目录；null = 还没选（可进入新会话页，但发不出去） */
	cwd: string | null;
	/** 起步模型；null = 还没定（等模型列表加载或用户选择补上） */
	model: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	permissionMode: PermissionMode;
	/** 模型是否已定（会话快照或用户选择）：false 时 loadModels 才用默认值补 */
	modelResolved: boolean;
	/** 思考档位是否已定。**与 modelResolved 分开**：只改过档位不得阻止模型补齐（反之亦然） */
	thinkingResolved: boolean;
	/**
	 * 内部代次（不给 UI 用）：同一份 draft 的每次字段编辑共享它，新建一份就是新代次。
	 * promotion 的 single-flight 按它隔离 —— D1 已消费、还在等权限 IPC 时用户又建了 D2，
	 * D2 必须另发一次 createSession，不能复用 D1 的 Promise（否则 D2 的消息会发进 D1 的会话）。
	 */
	generation: number;
}

let draftGenerationSeq = 0;

/**
 * 造一份 draft 配置。**有真实会话来源的字段才算「已定」**，没来源的一律留给 `loadModels`
 * 用持久化偏好回填（冷启动时 lastUsedThinkingLevel 还只是占位 `medium`，不能当成用户选择）。
 */
function makeDraft(
	state: Pick<SessionsStore, "cwd" | "lastUsedModel" | "lastUsedThinkingLevel">,
	source: {
		cwd?: string | null;
		model?: { provider: string; modelId: string } | null;
		thinkingLevel?: string | null;
	} = {},
): NewSessionDraftConfig {
	const model = source.model ?? null;
	draftGenerationSeq += 1;
	return {
		cwd: source.cwd ?? state.cwd,
		model,
		// 未定时先用「最近使用」占位（UI 立刻有值），但标成未定，等 loadModels 用持久化偏好回填
		thinkingLevel: source.thinkingLevel ?? state.lastUsedThinkingLevel,
		permissionMode: "default",
		modelResolved: model != null,
		thinkingResolved: source.thinkingLevel != null,
		generation: draftGenerationSeq,
	};
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
 * 顶栏展示集（v8 定稿）：**严格 = 置顶表**——顶栏胶囊就是置顶会话（不管它的 tab 开没开）。
 * 用户：顶栏之前是「打开的会话全进去」= 唯一的会话总表，胶囊越来越多；现在左栏承担总表，
 * 顶栏只放真正需要盯的会话（新会话的导航在左栏与顶栏「＋」，见 spec D1/D3）。
 * - **不能只从 tabs 里筛**：会话被置顶、但 tab 已关（或本次启动没恢复）时，只筛 tabs 会把它藏掉，
 *   用户会看到「已置顶却不在顶栏」——所以置顶会话的 meta 从 tabs → 历史两边找，点击时自动开。
 * - 顺序 = `pinnedSessions` 自己的顺序（置顶即插队到最左，拖动排序改的也是它）。
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
	return (
		pinnedSessions
			.map((id) => byId.get(id))
			// 纵深防御：置顶表里可能残留只读子会话（旧 ui-state / 手改）——不生成只读胶囊。
			// 与左栏同一道判据（lib/session-visibility），不要各写一份
			.filter((s): s is SessionMeta => s !== undefined && isPrimaryNavigationSession(s))
	);
}

/**
 * 进程内单调激活序号（spec D2）：**用户导航动作一开始**就领号（不能等 IPC 返回才领，否则表达不了点击顺序）。
 * 异步动作返回时只有「自己领的号仍是最新」才允许写 `activeSessionId/cwd/rememberCwd`；
 * 过期的仍可落数据（sessions 条目、transcript 装载），但不得抄回焦点。
 *
 * 不落盘、不进 store：重启后一个在途动作都没有，序号归零无意义；测试间保留递增即可。
 */
let activationSeq = 0;

function claimActivation(): number {
	activationSeq += 1;
	return activationSeq;
}

/** 领号后所有更早的在途导航立即失效（同步 `switchSession` 因此天然淘汰在飞的 open/create/fork） */
function isLatestActivation(token: number): boolean {
	return token === activationSeq;
}

/** 同会话在途的 bundle 装载（key = sessionId） */
const bundleInFlight = new Map<string, Promise<void>>();

/**
 * 打开会话时同步四件套：消息历史（可选跳过 live 态）、排队队列、todo 面板、权限模式。
 * 取数并行（各写 store 不同字段，无交叉读），应用顺序保持 history → queue → todos。
 * 权限模式对齐后端真值：关 tab 重开后端已归零 default，拉回防 stale（spec permission-mode D1）。
 *
 * 同会话同时在途时复用同一个 Promise（spec D3，见 `ensureOpenSession`）：open 完成时 meta 会先落进
 * `sessions`，用户这时再点那一行就走 `switchSession` 的懒加载，两条路会撞车重复拉四件套。
 */
function loadSessionBundle(sessionId: string, opts?: { skipHistoryIfLive?: boolean }): Promise<void> {
	const existing = bundleInFlight.get(sessionId);
	if (existing) return existing;
	const promise = loadSessionBundleInner(sessionId, opts).finally(() => {
		if (bundleInFlight.get(sessionId) === promise) bundleInFlight.delete(sessionId);
	});
	bundleInFlight.set(sessionId, promise);
	return promise;
}

async function loadSessionBundleInner(
	sessionId: string,
	opts?: { skipHistoryIfLive?: boolean },
): Promise<void> {
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
	// D7：本机记住过的档位盖过后端默认值（后端 mode 不落盘，重启/卸载重开后恒为 default）。
	// 这里 await 而不是 fire-and-forget：保证「打开完就是正确档位」，验收才能确定性断言。
	const remembered = useUiPreferencesStore.getState().sessionPermissionModes[sessionId];
	if (remembered && remembered !== permissionMode) {
		try {
			await getPi().setPermissionMode({ sessionId, mode: remembered });
			applyBackendPermissionMode(sessionId, remembered);
		} catch (error) {
			console.warn("恢复会话权限模式失败", error);
		}
	}
}

/** 后端真值写入本 map（default = 删 key，保持「缺 key = default」语义） */
function applyBackendPermissionMode(sessionId: string, mode: PermissionMode): void {
	useSessionsStore.setState((state) => ({
		permissionModes: withPermissionMode(state.permissionModes, sessionId, mode),
	}));
}

/**
 * 后端会话被重建（GC 竞态恢复）后把权限档位拉回：新构造的会话一律 default 起步（D1：不落盘、不继承），
 * 而 renderer 里还持有用户选过的档位——不拉回就会出现「UI 显示 fullAccess、后端按 default 走」的静默偏差。
 *
 * 拉回失败时必须把 renderer 拉回 default（而不是保留旧档）：UI 永远反映 backend 真值，
 * 否则用户看到 fullAccess、实际后端在按 default 索要确认——静默权限分叉比多一个 toast 危险得多。
 * 持久偏好（uiPreferences.sessionPermissionModes）不动，下次打开/重启还能重试。
 */
async function restorePermissionMode(sessionId: string): Promise<void> {
	const mode = useSessionsStore.getState().permissionModes[sessionId];
	if (!mode || mode === "default") return;
	try {
		await getPi().setPermissionMode({ sessionId, mode });
	} catch (error) {
		console.warn("恢复会话权限模式失败", error);
		applyBackendPermissionMode(sessionId, "default");
		pushToast("warning", "toast.permissionModeFailed", errText(error));
	}
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
 * 失败整体回滚（乐观态 + ui-state 重新持久化）+ toast。新会话页（activeSessionId === null）没有
 * 后端会话：只写 draft 配置 + 跟随值，promotion 时随入口快照生效。
 */
async function optimisticSessionSetting(
	label: string,
	toastKey: "toast.modelSwitchFailed" | "toast.thinkingSwitchFailed",
	compute: () => {
		/** 乐观写入的跟随字段（lastUsedModel / lastUsedThinkingLevel） */
		global: { lastUsedModel?: { provider: string; modelId: string } | null; lastUsedThinkingLevel?: string };
		/** 乐观写入当前会话条目的补丁（model / thinkingLevel） */
		sessionPatch: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null };
		/** draft 页（activeSessionId === null）写 newSessionDraft 的补丁；draft 不调 IPC */
		draftPatch: Partial<
			Pick<NewSessionDraftConfig, "model" | "thinkingLevel" | "modelResolved" | "thinkingResolved">
		>;
		/** saveUiState 载荷（乐观与回滚各一次） */
		uiState: { lastUsedModel?: { provider: string; modelId: string } | null; lastUsedThinkingLevel?: string };
		/** 真实会话的 SDK 同步 */
		sync: (sessionId: string) => Promise<void>;
	},
): Promise<void> {
	const s = useSessionsStore.getState();
	const { activeSessionId } = s;
	// 只有「本次动作发生在 draft 页」才能动 draft 配置：单例 draft 会跨会话存活，
	// 在真实会话里改模型/思考不得覆盖后台那份 draft 快照
	const onDraftPage = activeSessionId === null;
	const previousGlobal = {
		lastUsedModel: s.lastUsedModel,
		lastUsedThinkingLevel: s.lastUsedThinkingLevel,
	};
	const previousSession = s.sessions.find((x) => x.sessionId === activeSessionId);
	const { global, sessionPatch, draftPatch, uiState, sync } = compute();
	const apply = (
		g: { lastUsedModel?: { provider: string; modelId: string } | null; lastUsedThinkingLevel?: string },
		patch: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null },
		draft: Partial<
			Pick<NewSessionDraftConfig, "model" | "thinkingLevel" | "modelResolved" | "thinkingResolved">
		>,
	) =>
		useSessionsStore.setState((state) => ({
			...g,
			sessions: state.sessions.map((x) => (x.sessionId === activeSessionId ? { ...x, ...patch } : x)),
			// draft 页没有会话条目可写：选择落在 draft 配置上（promotion 时随快照生效）
			newSessionDraft: state.newSessionDraft ? { ...state.newSessionDraft, ...draft } : null,
		}));
	apply(global, sessionPatch, onDraftPage ? draftPatch : {});
	getPi()
		.saveUiState({ state: uiState })
		.catch((error) => {
			console.error("ui-state 持久化失败", error);
			pushToast("warning", "toast.uiStateSaveFailed", errText(error));
		});
	// 新会话页（activeSessionId === null）没有后端会话：选择只写 draft 配置 + 跟随值，不调 SDK
	if (onDraftPage) return;
	try {
		await sync(activeSessionId);
	} catch (error) {
		// SDK 同步失败（如凭证缺失/模型不可用）：回滚乐观态 + 重新持久化 + toast
		apply(
			previousGlobal,
			previousSession
				? { model: previousSession.model, thinkingLevel: previousSession.thinkingLevel }
				: { model: null, thinkingLevel: null },
			// 不在 draft 页就没写过 draft，回滚也不能碰它（后台 draft 可能活着）
			{},
		);
		getPi()
			.saveUiState({ state: previousGlobal })
			.catch((e) => console.error("ui-state 回滚持久化失败", e));
		console.error(`${label}失败`, error);
		pushToast("warning", toastKey, errText(error));
	}
}

/**
 * 共享 open pipeline（spec D3）：key = 规范化 sessionFile（trim）。同一文件在途时复用同一个 Promise，
 * 因此「同一文件双击只发一次 IPC + 只装载一次 bundle + 失败只 toast 一次」；
 * settle（无论成败）后立即清 key，失败可以重试；不同文件互不影响。
 * 返回 null = 失败（提示已在共享链里报过，调用者不再重复报）。
 *
 * `loadBundle: false`（GC 竞态恢复专用）：只重建 backend 会话、刷新 meta，**不**重载磁盘历史——
 * idle transcript 必须原样保留（GC 不能把用户看到的对话内容重置成历史快照）。
 * 已有在途请求时用先到者的选项（不会重复发 IPC，也不会多跑一次 bundle）。
 *
 * 模块级 Map 只存正在执行的 Promise，不落盘、不进 store：没有任何「仅测试用的 reset 入口」。
 */
function ensureOpenSession(filePath: string, opts?: { loadBundle?: boolean }): Promise<SessionMeta | null> {
	const key = filePath.trim();
	const existing = openInFlight.get(key);
	if (existing) return existing;
	const promise = ensureOpenSessionInner(key, opts?.loadBundle !== false).finally(() => {
		if (openInFlight.get(key) === promise) openInFlight.delete(key);
	});
	openInFlight.set(key, promise);
	return promise;
}

const openInFlight = new Map<string, Promise<SessionMeta | null>>();

async function ensureOpenSessionInner(filePath: string, loadBundle: boolean): Promise<SessionMeta | null> {
	let meta: SessionMeta;
	try {
		meta = await getPi().openSession({ filePath });
	} catch (error) {
		console.error("打开会话失败", error);
		pushToast("warning", "toast.sessionOpenFailed", errText(error));
		return null;
	}
	// 数据先落：meta 进 tabs + LRU 打点 —— 这些与「谁抢到焦点」无关（由调用者的 token 决定）。
	// lastUsedAt 必须在数据路径打：用户确实点了这一行，不然 GC 会把它当成「从没用过」。
	useSessionsStore.setState((state) => ({
		sessions: [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta],
		lastUsedAt: { ...state.lastUsedAt, [meta.sessionId]: Date.now() },
	}));
	if (!loadBundle) return meta;
	try {
		// 运行中子会话的事件已按其 sessionId 实时转发；保留已有流式态，
		// 否则会在点击卡片时把 agent_start 建立的进度视图重置为静态历史。
		await loadSessionBundle(meta.sessionId, { skipHistoryIfLive: true });
	} catch (error) {
		// 会话已经打开了（后端在内存里、meta 在 tabs）：数据装载失败只能提示，
		// 不能当成「打开失败」——否则用户点了行却什么都没发生。
		console.error("装载会话数据失败", error);
		pushToast("warning", "toast.sessionOpenFailed", errText(error));
	}
	return meta;
}

/**
 * 记住「上次项目目录」（重启后启动页预填，用户不用重选项目）。
 * 只写 cwd、**不恢复任何会话**（v10 启动纯空不变）；同值短路，避免切会话时频繁写 ui-state。
 * 四个调用点 = 新建会话（发首条消息转正）/ 切会话 / 从历史打开 / 在选择器里选项目，
 * 即「用户当前真的在用哪个项目」（选择器选过即表态，见 REVIEW 阶段 1 补丁）。
 */
function rememberCwd(cwd: string | null): void {
	if (!cwd) return;
	useUiPreferencesStore.getState().setLastCwd(cwd);
}

/** 信任前置：未决项目弹窗（结果落 trust.json），draft 拉斜杠命令/promotion 建会话直接命中缓存 */
function ensureTrust(cwd: string): void {
	void getPi()
		.ensureProjectTrust({ cwd })
		.then(() => useSessionsStore.setState((s) => ({ trustVersion: s.trustVersion + 1 })))
		.catch((error) => {
			console.error("项目信任检查失败", error);
			pushToast("warning", "toast.trustFailed", errText(error));
		});
}

/** promotion 的 single-flight（按 draft generation 隔离；同一份 draft 的并发发送/命令共享一次 create） */
let promotion: { generation: number; done: Promise<string | null> } | null = null;

/**
 * draft → 真实会话：用 draft **入口快照**（cwd/model/thinking/permission 同一时点冻结）建会话，
 * 成功才消费 draft（失败保留 draft 与输入内容，用户重试就行）；promotion 会切到新会话 = 用户导航，
 * 所以先领号：迟到结果只落 sessions、不抢焦点/cwd。
 */
async function promoteDraft(draft: NewSessionDraftConfig): Promise<string | null> {
	const targetCwd = draft.cwd;
	if (!targetCwd) return null;
	const token = claimActivation();
	try {
		const meta = await getPi().createSession({
			options: {
				cwd: targetCwd,
				...(draft.model ?? {}),
				thinkingLevel: draft.thinkingLevel,
			},
		});
		useSessionsStore.setState((state) => {
			// 同 id 已存在就不再 append（与 open pipeline 同一套防御性去重）
			const sessions = state.sessions.some((s) => s.sessionId === meta.sessionId)
				? state.sessions
				: [...state.sessions, meta];
			const landed = { sessions, lastUsedAt: { ...state.lastUsedAt, [meta.sessionId]: Date.now() } };
			if (isLatestActivation(token)) {
				// 消费 draft：转正成功后新会话页不再留草稿（下次「＋」再按当时的会话快照新建一份）
				return { ...landed, newSessionDraft: null, activeSessionId: meta.sessionId, cwd: targetCwd };
			}
			// 迟到（用户已切走）：新会话仍进 sessions，但不抢焦点/cwd。
			// 注意「转正途中点了『＋』」：此刻用户就在新会话页，而本次已消费掉那份 draft ——
			// 必须马上补一份，维持「新会话页必有 draft」不变式（否则 picker 的写入会静默丢失）
			return {
				...landed,
				// 用户可能已通过项目行把同一份全局 draft 改投到另一个 cwd；迟到的旧 promotion
				// 只能补「确实不存在」的 draft，不能覆盖这份更新后的新意图。
				newSessionDraft:
					state.activeSessionId === null
						? (state.newSessionDraft ?? makeDraft(state, { cwd: state.cwd }))
						: null,
			};
		});
		useTranscriptStore.getState().resetSession(meta.sessionId);
		if (isLatestActivation(token)) rememberCwd(targetCwd);
		// draft 上选过的权限档位（入口快照）：后端新会话一律 default 起步，这里补上
		// （失败只 toast，不回滚转正）
		if (draft.permissionMode !== "default") {
			await useSessionsStore.getState().setSessionPermissionMode(meta.sessionId, draft.permissionMode);
		}
		return meta.sessionId;
	} catch (error) {
		// 失败：draft 与输入内容都保留，用户重试即可；toast 提示（非会话内容，不残留）
		console.error("创建会话失败", error);
		pushToast("warning", "toast.sessionCreateFailed", errText(error));
		return null;
	}
}

/** 顶栏打开的会话持久化（重启恢复用）；由主进程写 userData/tabs.json，不依赖 renderer localStorage */
interface SessionsStore {
	sessions: SessionMeta[];
	activeSessionId: string | null;
	cwd: string | null;
	models: AvailableModel[];
	/** 全局唯一的新会话 draft；null = 当前已有真实会话（或还没初始化） */
	newSessionDraft: NewSessionDraftConfig | null;
	/** 上次使用的模型/思考深度（新会话与 draft 起步跟随；持久化 ui-state.json，语义 = 跟随最近选择，非独立默认设置） */
	lastUsedModel: { provider: string; modelId: string } | null;
	lastUsedThinkingLevel: string;
	/** 项目信任决策完成计数：ensureProjectTrust 应答后 +1，驱动 draft 斜杠菜单按新决策重拉 */
	trustVersion: number;
	/** 按会话权限模式（缺 key = default）；draft 的档位在 `newSessionDraft.permissionMode` 里，不占本表 */
	permissionModes: Record<string, PermissionMode>;
	/**
	 * 最近使用时刻（毫秒，内存策略 LRU 打点）：打开/新建/切走时更新，卸载/关闭时删表项。
	 * 只活在本次进程（不落盘）：重启后一个会话都没打开，本来也没有 LRU 可言。
	 */
	lastUsedAt: Record<string, number>;
	/**
	 * promotion：把当前 draft 变成真实会话（首条消息/斜杠命令触发）。返回新会话 id；
	 * 没 draft / draft 无 cwd → null（调用方据此中止发送）；失败也返回 null 但**保留 draft**（可重试）。
	 * **调用方必须用返回值定位新会话**，不能读 `activeSessionId`：创建是异步的，
	 * 期间用户可能已切走（latest-wins 下新会话可能不抢焦点），读 active 会拿到别人的 id。
	 */
	createSession: () => Promise<string | null>;
	/**
	 * 激活新会话页（顶栏「＋」/ 启动初始化）。当前有真实会话时以它的项目/模型/思考/权限为起点；
	 * 已经在 draft 页时只激活、不覆盖用户选过的配置（`cwd` 参数只给未选项目的启动 draft 补起点）。
	 */
	activateNewSessionDraft: (cwd?: string) => void;
	/**
	 * 从项目行进入新会话：仍复用全局唯一 draft，但明确把它改投到指定 cwd。
	 * 与无参数入口不同，这里 cwd 是用户显式选择，必须覆盖已有 draft 的项目。
	 */
	activateNewSessionDraftForCwd: (cwd: string) => void;
	/** 设置新会话的目标项目目录（项目选择器）；draft 没有就一直只记全局默认 */
	setDraftCwd: (cwd: string) => void;
	/** draft 的权限档位（纯 renderer，promotion 时才应用到后端会话） */
	setDraftPermissionMode: (mode: PermissionMode) => void;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string, intent?: SessionCloseIntent) => Promise<{ closed: boolean }>;
	/** 自动卸载（内存策略专用，见实现处注释）；传 intent="gc" 让后端区分自动 GC 与用户意图 */
	unloadSession: (sessionId: string) => Promise<{ closed: boolean }>;
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
	/** 切换会话权限模式（真实会话乐观更新 + 失败回滚 + toast；draft 走 setDraftPermissionMode） */
	setSessionPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<void>;
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
	sessions: [],
	activeSessionId: null,
	cwd: null,
	models: [],
	// 不变式：新会话页（`activeSessionId === null`）必须有一份 draft。开机就是新会话页，
	// 所以初始化就建好（App 启动再把 lastCwd 种进来，见 App.tsx），不留「active=null 且 draft=null」的窗口
	newSessionDraft: makeDraft({ cwd: null, lastUsedModel: null, lastUsedThinkingLevel: "medium" }),
	lastUsedModel: null,
	lastUsedThinkingLevel: "medium",
	trustVersion: 0,
	permissionModes: {},
	lastUsedAt: {},

	// promotion：draft → 真实会话。single-flight 按 draft generation 隔离（不落盘、不进 store）
	createSession: () => {
		const draft = get().newSessionDraft;
		// 没 draft / 还没选项目 = 没什么可转正：不静默建会话，由调用方中止发送并提示
		if (!draft?.cwd) return Promise.resolve(null);
		// 同一份 draft 的并发发送/命令共享同一次 create；新 draft（新 generation）必须另起一次
		if (promotion?.generation === draft.generation) return promotion.done;
		const done = promoteDraft(draft);
		const self = { generation: draft.generation, done };
		promotion = self;
		void done.finally(() => {
			if (promotion === self) promotion = null;
		});
		return done;
	},

	activateNewSessionDraft: (cwd) => {
		const state = get();
		const activeSession = state.sessions.find((s) => s.sessionId === state.activeSessionId);
		if (activeSession) {
			// 从真实会话点顶部「新会话」：Codex 语义是以**当前对话**为模板，而不是回到后台 draft
			// 之前记住的项目。输入内容仍挂在全局 NEW_SESSION_DRAFT_KEY 上，不会因此丢失。
			// 显式 cwd 只供启动/内部调用覆盖目录；UI 顶部入口不传，因此自然采用当前会话 cwd。
			const targetCwd = cwd ?? activeSession.cwd;
			claimActivation();
			const nextDraft = makeDraft(state, {
				cwd: targetCwd,
				model: activeSession.model ?? state.lastUsedModel,
				thinkingLevel: activeSession.thinkingLevel,
			});
			nextDraft.permissionMode = state.permissionModes[activeSession.sessionId] ?? "default";
			set({ activeSessionId: null, cwd: targetCwd, newSessionDraft: nextDraft });
			ensureTrust(targetCwd);
			return;
		}

		const existing = state.newSessionDraft;
		if (existing) {
			// 已经在 draft 页：再次点击只激活，不覆盖用户在 draft 内选过的配置。
			// 只有「还没选项目」的那份（开机初始化/补种出来的，cwd === null）接受启动传入的 cwd。
			const targetCwd = existing.cwd ?? cwd ?? state.cwd;
			set({
				activeSessionId: null,
				cwd: targetCwd,
				newSessionDraft: { ...existing, cwd: targetCwd },
			});
			if (targetCwd) ensureTrust(targetCwd);
			return;
		}

		const targetCwd = cwd ?? state.cwd;
		set({
			activeSessionId: null,
			cwd: targetCwd,
			newSessionDraft: makeDraft(state, { cwd: targetCwd }),
		});
		if (targetCwd) ensureTrust(targetCwd);
	},

	activateNewSessionDraftForCwd: (cwd) => {
		const state = get();
		const activeSession = state.sessions.find((s) => s.sessionId === state.activeSessionId);
		// 与普通「＋」不同，项目行点击即使已经在 draft 页也是一次新的导航意图：
		// 淘汰在途 open/create/fork，且换 generation，避免旧 cwd 的 promotion single-flight 被复用。
		claimActivation();
		const existing = state.newSessionDraft;
		draftGenerationSeq += existing ? 1 : 0;
		const newSessionDraft = existing
			? { ...existing, cwd, generation: draftGenerationSeq }
			: makeDraft(state, {
					cwd,
					model: activeSession?.model ?? state.lastUsedModel,
					thinkingLevel: activeSession?.thinkingLevel,
				});
		set({ activeSessionId: null, cwd, newSessionDraft });
		ensureTrust(cwd);
		rememberCwd(cwd);
	},

	setDraftCwd: (cwd) => {
		// cwd 变化即前置信任决策
		ensureTrust(cwd);
		set((state) => ({
			cwd,
			newSessionDraft: state.newSessionDraft ? { ...state.newSessionDraft, cwd } : state.newSessionDraft,
		}));
		// 在选择器里选过项目 = 用户明确表态要用它：立刻记住（典型场景：首启选了项目、还没发消息就退出）
		rememberCwd(cwd);
	},

	setDraftPermissionMode: (mode) => {
		set((state) => ({
			newSessionDraft: state.newSessionDraft ? { ...state.newSessionDraft, permissionMode: mode } : null,
		}));
	},

	switchSession: (sessionId) => {
		// 同步导航：先领号，在途的 open/create/fork 全部作废（latest-wins 的另一半）
		claimActivation();
		set((state) => {
			const session = state.sessions.find((s) => s.sessionId === sessionId);
			return {
				activeSessionId: sessionId,
				cwd: session?.cwd ?? state.cwd,
				lastUsedAt: { ...state.lastUsedAt, [sessionId]: Date.now() },
			};
		});
		// 懒加载兜底（D4）：目标会话无 transcript 数据时补拉四件套（从历史打开、
		// 事件桥断连期间的切换等都经此路径自愈；已有数据零成本短路）
		if (useTranscriptStore.getState().bySession[sessionId] === undefined) {
			void loadSessionBundle(sessionId).catch((error) => {
				console.error("切换会话时补拉数据失败", error);
				pushToast("warning", "toast.sessionOpenFailed", errText(error));
			});
		}
		rememberCwd(get().cwd);
	},

	updateSessionName: (sessionId, name) =>
		set((state) => ({
			sessions: state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s)),
		})),

	closeSession: async (sessionId, intent) => {
		try {
			// intent 只在本轮是「内存策略自动卸载」时带上，用户主动关不传（保持既有语义）
			const { closed } = await getPi().closeSession(intent ? { sessionId, intent } : { sessionId });
			// 后端拒绝（agent 在跑 / 等审批）：**渲染层状态必须原样保留** —— 事务语义，
			// 不能出现「后端会话还在、前端条目已消失」的半个动作（内存策略也会看走眼）
			if (!closed) return { closed: false };
			// 自动卸载的选择竞态（spec D5）：策略判定「可卸」时它还不是 active，
			// 但 close 在我们这个 await 里真的关掉了它 —— 此时用户刚好选中了它。
			// 那样就把用户刚点的会话换成空白/消失 —— 所以重新打开后端会话，而不是把 UI 抹掉。
			// 只重建 backend（loadBundle:false）：**不**重载磁盘历史，idle transcript 原样保留。
			if (intent === "gc" && get().activeSessionId === sessionId) {
				const file = get().sessions.find((s) => s.sessionId === sessionId)?.sessionFile;
				if (file && (await ensureOpenSession(file, { loadBundle: false }))) {
					await restorePermissionMode(sessionId);
					return { closed: false };
				}
				// 恢复失败（或没有会话文件）：下面的常规清理照走；提示已由共享 open 链报过一次
			}
		} catch (error) {
			// 会话关闭失败：UI 状态保留（用户可重试），显形不静默（曾「点了没反应」）
			console.error("关闭会话失败", error);
			pushToast("warning", "toast.closeFailed", errText(error));
			return { closed: false };
		}
		useTranscriptStore.getState().resetSession(sessionId);
		set((state) => {
			const closing = state.sessions.find((s) => s.sessionId === sessionId);
			const sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
			const activeSessionId =
				state.activeSessionId === sessionId ? (sessions[0]?.sessionId ?? null) : state.activeSessionId;
			// 切 active 后 cwd 同步到新活跃会话的项目（否则跨项目关会话后 cwd 残留旧项目，新建会话归属错）（B5）
			const fallbackCwd = activeSessionId
				? (sessions.find((s) => s.sessionId === activeSessionId)?.cwd ?? state.cwd)
				: state.cwd;
			// 关掉最后一个会话 = 回到新会话页：不变式要求这里必须有 draft，否则新会话页的
			// picker 写入会静默丢失。起步快照取刚关掉的那个会话（与「＋」同一套语义）；
			// 已有后台 draft 则保留它（配置不拿被关会话覆盖）
			const newSessionDraft =
				activeSessionId === null
					? (state.newSessionDraft ??
						makeDraft(state, {
							cwd: fallbackCwd,
							model: closing?.model,
							thinkingLevel: closing?.thinkingLevel,
						}))
					: state.newSessionDraft;
			// 新会话页的 cwd 真相是 draft.cwd（项目选择器 / Sidebar activeCwd / promotion 都读它）：
			// 严格镜像它（**含 null**）—— 不能回退到被关闭会话的项目，
			// 否则又回到「页面/promotion 两处说法」（draft 还没选项目时 store.cwd 也得是 null）
			const cwd = activeSessionId === null ? (newSessionDraft?.cwd ?? null) : fallbackCwd;
			// 权限模式随会话销毁归零（后端 holder 同点位清理）
			const permissionModes = withPermissionMode(state.permissionModes, sessionId, "default");
			// LRU 打点随会话一起清（表项留着就是泄漏：只会积攒不再打开的 id）
			const lastUsedAt = { ...state.lastUsedAt };
			delete lastUsedAt[sessionId];
			return { sessions, activeSessionId, cwd, permissionModes, lastUsedAt, newSessionDraft };
		});
		return { closed: true };
	},

	/** 自动卸载（内存策略专用）：与 closeSession 同一套行为，只是把调用点与意图区分开——
	 *  「用户主动关/删」走 closeSession（intent 缺省 = user），「内存策略判定该卸」走这里并带 intent="gc"：
	 *  后端据此对「有频道订阅」的会话拒绝（订阅 = 明确驻留语义，见 spec channel-watch retention）。
	 *  受保护会话不会走到这里（保护判定在 lib/session-gc.ts 的 isProtected，订阅条件也在那边）；
	 *  返回 `closed=false` 表示后端拒绝（竞态：策略判定后它恰好又开始跑了/刚订阅了）。 */
	unloadSession: (sessionId) => get().closeSession(sessionId, "gc"),

	openFromHistory: async (filePath) => {
		// 先领号再发请求：这次点击就是当前最新意图（同文件双击则第二次领号，自然胜出）
		const token = claimActivation();
		const meta = await ensureOpenSession(filePath);
		// 失败已由共享链报过一次；这里的提前返回同时保证不对用户的新选择做任何回滚
		if (!meta || !isLatestActivation(token)) return;
		set({ activeSessionId: meta.sessionId, cwd: meta.cwd });
		// 先记 cwd 再拉数据：即便随后装载失败，用户「在用哪个项目」的事实也已经成立
		rememberCwd(meta.cwd);
	},

	forkSession: async (ref) => {
		const { activeSessionId } = get();
		// 新会话页还没有消息，无可分叉（UI 上也到不了这里，防御性拦截）
		if (!activeSessionId) return undefined;
		// 分叉成功会切到新会话 = 用户导航：先领号
		const token = claimActivation();
		try {
			const meta = await getPi().forkSession({ sessionId: activeSessionId, ref });
			set((state) => {
				const sessions = [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta];
				// 迟到：新会话仍进 tabs，但不抢焦点
				return isLatestActivation(token) ? { sessions, activeSessionId: meta.sessionId } : { sessions };
			});
			await loadSessionBundle(meta.sessionId);
			// fork 事实已发生：即便已不是最新意图也要把新 id 交给调用方
			return meta.sessionId;
		} catch (error) {
			console.error("分叉会话失败", error);
			pushToast("warning", "toast.forkFailed", errText(error));
			return undefined;
		}
	},

	recallMessage: async (ref) => {
		const { activeSessionId } = get();
		// 新会话页还没有消息，无可撤回（UI 上也到不了这里，防御性拦截）
		if (!activeSessionId) return;
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
		// 走 setDraftCwd：同时更新 draft 配置与全局 cwd（新会话归属哪个项目只看这一处）
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
			// draft 的起步模型：已定（会话快照/用户选过）就保留，没定就用刚解析出的默认值
			const draft = get().newSessionDraft;
			const draftModel = draft?.modelResolved ? draft.model : nextLastUsedModel;
			const draftModelRecord = draftModel
				? models.find((m) => m.provider === draftModel.provider && m.id === draftModel.modelId)
				: undefined;
			set({
				models,
				lastUsedModel: nextLastUsedModel,
				lastUsedThinkingLevel: clampedLevel,
				// draft 起步值（spec §5.1）：**分字段**判断已定/未定——
				// 模型未定时用默认值补；档位已定的仍要按所选模型的能力夹紧（与全局/会话同一套规则）
				newSessionDraft: draft
					? {
							...draft,
							model: draftModel,
							thinkingLevel: clampThinkingLevel(
								draft.thinkingResolved ? draft.thinkingLevel : clampedLevel,
								draftModelRecord?.thinkingLevels ?? [],
							),
						}
					: null,
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
			// draft 页：选择写进 draft 配置（两个 resolved 位分字段置位，互不干扰）
			draftPatch: {
				model: { provider, modelId },
				thinkingLevel,
				modelResolved: true,
				thinkingResolved: true,
			},
			uiState: { lastUsedModel: { provider, modelId }, lastUsedThinkingLevel: thinkingLevel },
			sync: (sessionId) => getPi().setModel({ sessionId, provider, modelId }),
		}));
	},

	/** 切换当前会话的思考深度：更新跟随记录 + 当前会话（只影响该会话），并同步 SDK（失败回滚 + toast） */
	setThinkingLevel: async (level) => {
		await optimisticSessionSetting("切换思考深度", "toast.thinkingSwitchFailed", () => ({
			global: { lastUsedThinkingLevel: level },
			sessionPatch: { thinkingLevel: level },
			// draft 页：只置「档位已定」，**不得**碰 modelResolved（改档位 ≠ 改模型，模型仍要能按默认补齐）
			draftPatch: { thinkingLevel: level, thinkingResolved: true },
			uiState: { lastUsedThinkingLevel: level },
			sync: (sessionId) => getPi().setThinkingLevel({ sessionId, level }),
		}));
	},

	/**
	 * 切换会话权限模式：乐观更新 + IPC 同步，失败回滚 + toast（范式同 setContextManagerMode）。
	 * 新会话页的档位不走这里（它存在 `newSessionDraft.permissionMode`，promotion 后由 store 应用）。
	 * 后端为内存态即时生效（每次 tool_call 实时读），无需重升会话。
	 */
	setSessionPermissionMode: async (sessionId, mode) => {
		const previous = get().permissionModes[sessionId] ?? "default";
		set((state) => ({ permissionModes: withPermissionMode(state.permissionModes, sessionId, mode) }));
		try {
			await getPi().setPermissionMode({ sessionId, mode });
			// D7：IPC 成功才记（失败回滚不记）；传 default 则会删键
			useUiPreferencesStore.getState().rememberPermissionMode(sessionId, mode);
		} catch (error) {
			set((state) => ({ permissionModes: withPermissionMode(state.permissionModes, sessionId, previous) }));
			console.error("切换权限模式失败", error);
			pushToast("warning", "toast.permissionModeFailed", errText(error));
		}
	},
}));
