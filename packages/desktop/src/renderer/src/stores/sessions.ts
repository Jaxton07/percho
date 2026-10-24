import {
	type AvailableModel,
	composerDocumentFromText,
	type EnvironmentRef,
	emptyTranscript,
	environmentEntityRef,
	environmentKey,
	LOCAL_ENVIRONMENT,
	type PermissionMode,
	type SessionCloseIntent,
	type SessionMeta,
	sameEnvironment,
} from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { releaseComposerEditor } from "../components/composer/editor-host";
import { getExecutionApi } from "../environment-api";
import { selectActiveCwd } from "../lib/active-cwd";
import { errText } from "../lib/error-text";
import { clampThinkingLevel } from "../lib/thinking";
import { useChannelSubscriptionsStore } from "./channel-subscriptions";
import {
	appendDraftInput,
	COMPOSER_FOCUS_EVENT,
	EMPTY_DRAFT,
	newSessionDraftKey,
	useDraftStore,
} from "./drafts";
import { invalidateInteractions, synchronizeInteractions } from "./interactions";
import {
	beginSessionBaseline,
	finishSessionBaseline,
	forgetSessionBoundary,
	pauseEnvironmentEvents,
	pendingSessionBaselineToken,
	resumeEnvironmentEvents,
} from "./session-event-boundary";
import {
	finishSessionHistory,
	hasPendingSessionHistory,
	isHistoryReady,
	retrySessionHistory,
} from "./session-history";
import { createSessionLoader } from "./session-loading";
import {
	claimActivation,
	isLatestActivation,
	isLatestNavigation,
	noteUserIntent,
} from "./session-navigation";

export {
	currentNavigationToken,
	currentUserIntentToken,
	isLatestNavigation,
	isLatestUserIntent,
} from "./session-navigation";

import { useSessionWorkspaceStore } from "./session-workspace";
import { useSubagentReturnStore } from "./subagent-return";
import { pushToast } from "./toasts";
import { useTranscriptStore } from "./transcript";
import { useUiPreferencesStore } from "./ui-preferences";

/**
 * 新会话 draft（renderer 全局唯一编辑态，spec §5.1）：**不进 `sessions`、不落盘、不触后端**。
 * 整个 renderer 最多一份，`activeSessionId === null` 时它就是当前页面；首条消息 promotion 时
 * 用这份快照建真实会话（快照优先于全局「最近使用」值）。
 */
export interface NewSessionDraftConfig {
	/** Captured execution owner; optional only for legacy local fixtures during migration. */
	environment?: EnvironmentRef;
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
const modelLoads = new Map<string, number>();

/**
 * 造一份 draft 配置。**有真实会话来源的字段才算「已定」**，没来源的一律留给 `loadModels`
 * 用持久化偏好回填（冷启动时 lastUsedThinkingLevel 还只是占位 `medium`，不能当成用户选择）。
 */
function makeDraft(
	state: Pick<SessionsStore, "cwd" | "lastUsedModel" | "lastUsedThinkingLevel"> &
		Partial<Pick<SessionsStore, "activeSessionId" | "newSessionDraft">>,
	source: {
		environment?: EnvironmentRef;
		cwd?: string | null;
		model?: { provider: string; modelId: string } | null;
		thinkingLevel?: string | null;
	} = {},
): NewSessionDraftConfig {
	const model = source.model ?? null;
	draftGenerationSeq += 1;
	return {
		environment:
			source.environment ??
			(state.activeSessionId
				? environmentEntityRef(state.activeSessionId).environment
				: (state.newSessionDraft?.environment ?? LOCAL_ENVIRONMENT)),
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
 * 置顶分区：置顶会话在前（内部保持原顺序），其余按原顺序跟在后面。
 * **v12 起只用于左栏/项目页**（顶栏胶囊与左侧轨道看的是临时会话工作区，顺序由成员表定，不参与置顶分区）；稳定分区而非排序。
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
 * `openFromHistory` 的结果：`ok:false` = 请求失败（已 toast）或被关闭forget作废（静默）；`latest:false` = 会话确实开了，
 * 但用户在等待期间又导航了 —— 调用方只能落数据，不得抢焦点/`activeFile`。
 *
 * `token` = 本次导航领的激活序号：调用方在**提交副作用前**可以再核对一次「还是不是最新意图」
 * （spec D4：关系提交不能只看 activeSessionId —— 同一个子会话被再点一次也是更新的意图）。
 */
export type OpenFromHistoryResult =
	| { ok: false }
	| { ok: true; latest: boolean; meta: SessionMeta; token: number };

/** 后端真值写入本 map（default = 删 key，保持「缺 key = default」语义） */
function applyBackendPermissionMode(sessionId: string, mode: PermissionMode): void {
	commitSessionState((state) => ({
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
		commitSessionState((state) => ({
			...(state.activeSessionId === activeSessionId ? g : {}),
			sessions: state.sessions.map((x) => (x.sessionId === activeSessionId ? { ...x, ...patch } : x)),
			// draft 页没有会话条目可写：选择落在 draft 配置上（promotion 时随快照生效）
			newSessionDraft:
				state.newSessionDraft && state.newSessionDraft.generation === s.newSessionDraft?.generation
					? { ...state.newSessionDraft, ...draft }
					: state.newSessionDraft,
		}));
	apply(global, sessionPatch, onDraftPage ? draftPatch : {});
	(currentEnvironment(s).kind === "local"
		? getPi().saveUiState({ state: uiState })
		: Promise.resolve()
	).catch((error) => {
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
		(currentEnvironment(s).kind === "local"
			? getPi().saveUiState({ state: previousGlobal })
			: Promise.resolve()
		).catch((e) => console.error("ui-state 回滚持久化失败", e));
		console.error(`${label}失败`, error);
		pushToast("warning", toastKey, errText(error));
	}
}

/**
 * 记住「上次项目目录」（重启后启动页预填，用户不用重选项目）。
 * 只写 cwd、**不恢复任何会话**（v10 启动纯空不变）；同值短路，避免切会话时频繁写 ui-state。
 * 四个调用点 = 新建会话（发首条消息转正）/ 切会话 / 从历史打开 / 在选择器里选项目，
 * 即「用户当前真的在用哪个项目」（选择器选过即表态，见 REVIEW 阶段 1 补丁）。
 */
function rememberCwd(cwd: string | null): void {
	if (!cwd || currentEnvironment(useSessionsStore.getState()).kind !== "local") return;
	useUiPreferencesStore.getState().setLastCwd(cwd);
}

/** 信任前置：未决项目弹窗（结果落 trust.json），draft 拉斜杠命令/promotion 建会话直接命中缓存 */
function ensureTrust(cwd: string, environment: EnvironmentRef = environmentEntityRef(cwd).environment): void {
	void getExecutionApi(environment)
		.ensureProjectTrust({ cwd })
		.then(() => commitSessionState((s) => ({ trustVersion: s.trustVersion + 1 })))
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
	// 用户发送 = 用户意图：迟到的启动恢复不得再把页面换成快照里的旧会话
	noteUserIntent();
	const targetCwd = draft.cwd;
	const inputKey = newSessionDraftKey(draft.environment, draft.cwd);
	if (!targetCwd) return null;
	const token = claimActivation();
	try {
		const meta = await getExecutionApi(draft.environment ?? LOCAL_ENVIRONMENT).createSession({
			options: {
				cwd: targetCwd,
				...(draft.model ?? {}),
				thinkingLevel: draft.thinkingLevel,
			},
		});
		// 转正成功 = 用户刚开的会话 → 记入临时工作区（锚点 = 上一刻在看的成员，落在它右侧）。
		// 迟到（已不是最新意图）只进工作区、不抢 activeFile（与下面的焦点处理同一口径）。
		useSessionWorkspaceStore
			.getState()
			.addMember(
				{ file: meta.sessionFile, sessionId: meta.sessionId },
				{ activate: isLatestActivation(token) },
			);
		if (
			isLatestActivation(token) &&
			useSessionsStore.getState().newSessionDraft?.generation === draft.generation
		) {
			const remaining = useDraftStore.getState().bySession[inputKey];
			if (remaining) {
				useDraftStore.getState().updateDraft(meta.sessionId, () => remaining);
				useDraftStore.getState().updateDraft(inputKey, () => EMPTY_DRAFT);
			}
			releaseComposerEditor(inputKey);
		}
		commitSessionState((state) => {
			// 同 id 已存在就不再 append（与 open pipeline 同一套防御性去重）
			const sessions = state.sessions.some((s) => s.sessionId === meta.sessionId)
				? state.sessions
				: [...state.sessions, meta];
			const landed = { sessions, lastUsedAt: { ...state.lastUsedAt, [meta.sessionId]: Date.now() } };
			if (isLatestActivation(token)) {
				// 消费 draft：转正成功后新会话页不再留草稿（下次「＋」再按当时的会话快照新建一份）
				return { ...landed, newSessionDraft: null, activeSessionId: meta.sessionId };
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
		// 全新会话的历史底座天然为空；在首次用户消息前即确认就绪。
		finishSessionHistory(meta.sessionId);
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

/** 会话列表/导航/当前会话状态（**v10 起不再持久化「打开列表」**：重启只由工作区恢复链按需加载 activeFile 一条） */
interface SessionsStore {
	sessions: SessionMeta[];
	activeSessionId: string | null;
	cwd: string | null;
	models: AvailableModel[];
	modelsByEnvironment: Record<string, AvailableModel[]>;
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
	activateNewSessionDraftForCwd: (cwd: string, environment?: EnvironmentRef) => void;
	/** 设置新会话的目标项目目录（项目选择器）；draft 没有就一直只记全局默认 */
	setDraftCwd: (cwd: string, environment?: EnvironmentRef) => void;
	/** draft 的权限档位（纯 renderer，promotion 时才应用到后端会话） */
	setDraftPermissionMode: (mode: PermissionMode) => void;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string, intent?: SessionCloseIntent) => Promise<{ closed: boolean }>;
	/** 自动卸载（内存策略专用，见实现处注释）；传 intent="gc" 让后端区分自动 GC 与用户意图 */
	unloadSession: (sessionId: string) => Promise<{ closed: boolean }>;
	openFromHistory: (filePath: string) => Promise<OpenFromHistoryResult>;
	/** 子代理检视打开（spec D4）：捕获父目标 + 只在最新导航意图下建立返回关系 */
	openSubagentSession: (filePath: string) => Promise<OpenFromHistoryResult>;
	/** 从子代理检视页回到父会话（父仍加载则切，已卸载则按文件重开） */
	returnToParent: (childSessionId: string) => Promise<boolean>;
	/** 在指定 assistant 消息处分叉：新会话以新 tab 打开并切换过去（原会话保留原样）；成功返回新 sessionId */
	forkSession: (ref: { entryId?: string; text?: string }) => Promise<string | undefined>;
	/** 撤回一条用户消息：会话回退到该消息之前，文本/图片放回输入框草稿继续编辑 */
	recallMessage: (ref: { entryId?: string; text?: string; timestamp?: number }) => Promise<void>;
	/** 自动命名等事件带来的标题变更 */
	updateSessionName: (sessionId: string, name: string | undefined) => void;
	pickDirectory: () => Promise<void>;
	loadModels: (environment?: EnvironmentRef) => Promise<void>;
	setCurrentModel: (provider: string, modelId: string) => Promise<void>;
	setThinkingLevel: (level: string) => Promise<void>;
	/** 切换会话权限模式（真实会话乐观更新 + 失败回滚 + toast；draft 走 setDraftPermissionMode） */
	setSessionPermissionMode: (sessionId: string, mode: PermissionMode) => Promise<void>;
}

function currentEnvironment(
	state: Pick<SessionsStore, "activeSessionId" | "newSessionDraft">,
): EnvironmentRef {
	return state.activeSessionId
		? environmentEntityRef(state.activeSessionId).environment
		: (state.newSessionDraft?.environment ?? LOCAL_ENVIRONMENT);
}

/** Host-only commit projects the final patched state; external Zustand setState stays native. */
function commitSessionState(
	patch: Partial<SessionsStore> | ((state: SessionsStore) => Partial<SessionsStore>),
): void {
	useSessionsStore.setState((state) => {
		const changes = typeof patch === "function" ? patch(state) : patch;
		return { ...changes, cwd: selectActiveCwd({ ...state, ...changes }) };
	});
}

// Host action writes use the explicit commit; Zustand's public setState is not wrapped.
const set = commitSessionState;
export const useSessionsStore = create<SessionsStore>((_set, get) => ({
	sessions: [],
	activeSessionId: null,
	cwd: null,
	models: [],
	modelsByEnvironment: {},
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
		// 用户导航意图（供启动恢复链判「用户已经自己选过页面」）。刻意不动 activationSeq：
		// 「已经在 draft 页时再点＋」不该作废在途的 promotion 落地（见单例 draft 的既有断言）。
		noteUserIntent();
		const activeSession = state.sessions.find((s) => s.sessionId === state.activeSessionId);
		if (activeSession) {
			// 从真实会话点顶部「新会话」：Codex 语义是以**当前对话**为模板，而不是回到后台 draft
			// 之前记住的项目。输入内容仍挂在全局 inputKey 上，不会因此丢失。
			// 显式 cwd 只供启动/内部调用覆盖目录；UI 顶部入口不传，因此自然采用当前会话 cwd。
			const targetCwd = cwd ?? activeSession.cwd;
			const environment = environmentEntityRef(activeSession.sessionId).environment;
			claimActivation();
			const nextDraft = makeDraft(state, {
				environment,
				cwd: targetCwd,
				model: activeSession.model ?? state.lastUsedModel,
				thinkingLevel: activeSession.thinkingLevel,
			});
			nextDraft.permissionMode =
				environment.kind === "local"
					? (state.permissionModes[activeSession.sessionId] ?? "default")
					: "default";
			set({ activeSessionId: null, newSessionDraft: nextDraft });
			ensureTrust(targetCwd, environment);
			return;
		}

		const existing = state.newSessionDraft;
		if (existing) {
			// 已经在 draft 页：再次点击只激活，不覆盖用户在 draft 内选过的配置。
			// 只有「还没选项目」的那份（开机初始化/补种出来的，cwd === null）接受启动传入的 cwd。
			const targetCwd = existing.cwd ?? cwd ?? state.cwd;
			set({
				activeSessionId: null,
				newSessionDraft: { ...existing, cwd: targetCwd },
			});
			if (targetCwd) ensureTrust(targetCwd, currentEnvironment(get()));
			return;
		}

		const targetCwd = cwd ?? state.cwd;
		set({
			activeSessionId: null,
			newSessionDraft: makeDraft(state, { cwd: targetCwd }),
		});
		if (targetCwd) ensureTrust(targetCwd, currentEnvironment(get()));
	},

	activateNewSessionDraftForCwd: (cwd, environment = environmentEntityRef(cwd).environment) => {
		const state = get();
		const activeSession = state.sessions.find((s) => s.sessionId === state.activeSessionId);
		const sourceSession =
			activeSession && sameEnvironment(environmentEntityRef(activeSession.sessionId).environment, environment)
				? activeSession
				: undefined;
		const followsCurrentEnvironment = sameEnvironment(currentEnvironment(state), environment);
		// 与普通「＋」不同，项目行点击即使已经在 draft 页也是一次新的导航意图：
		// 淘汰在途 open/create/fork，且换 generation，避免旧 cwd 的 promotion single-flight 被复用。
		claimActivation();
		noteUserIntent();
		const existing = state.newSessionDraft;
		draftGenerationSeq += existing ? 1 : 0;
		const changedEnvironment =
			existing && !sameEnvironment(existing.environment ?? LOCAL_ENVIRONMENT, environment);
		const newSessionDraft = existing
			? {
					...existing,
					environment,
					cwd,
					generation: draftGenerationSeq,
					...(changedEnvironment
						? {
								model: null,
								modelResolved: false,
								thinkingResolved: false,
								permissionMode: "default" as const,
							}
						: {}),
				}
			: makeDraft(state, {
					environment,
					cwd,
					model: sourceSession?.model ?? (followsCurrentEnvironment ? state.lastUsedModel : null),
					thinkingLevel: sourceSession?.thinkingLevel,
				});
		set({ activeSessionId: null, newSessionDraft });
		ensureTrust(cwd, environment);
		rememberCwd(cwd);
	},

	setDraftCwd: (cwd, environment = environmentEntityRef(cwd).environment) => {
		claimActivation();
		noteUserIntent();
		// cwd 变化即前置信任决策
		ensureTrust(cwd, environment);
		set((state) => {
			const draft = state.newSessionDraft;
			if (!draft) return {};
			const changed =
				draft.cwd !== cwd || !sameEnvironment(draft.environment ?? LOCAL_ENVIRONMENT, environment);
			return {
				newSessionDraft: {
					...draft,
					environment,
					cwd,
					generation: changed ? ++draftGenerationSeq : draft.generation,
					...(!sameEnvironment(draft.environment ?? LOCAL_ENVIRONMENT, environment)
						? {
								model: null,
								modelResolved: false,
								thinkingResolved: false,
								permissionMode: "default" as const,
							}
						: {}),
				},
			};
		});
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
		noteUserIntent();
		set((state) => {
			return {
				activeSessionId: sessionId,
				lastUsedAt: { ...state.lastUsedAt, [sessionId]: Date.now() },
			};
		});
		// 懒加载兜底（D4）：目标会话无 transcript 数据时补拉四件套（从历史打开、
		// 事件桥断连期间的切换等都经此路径自愈；已有数据零成本短路）
		if (environmentEntityRef(sessionId).environment.kind === "ssh" && !isHistoryReady(sessionId)) {
			void loadSessionBundle(sessionId).catch((error) =>
				pushToast("warning", "toast.sessionOpenFailed", errText(error)),
			);
		} else if (!isHistoryReady(sessionId) && hasPendingSessionHistory(sessionId)) {
			void retrySessionHistory(sessionId);
		} else if (useTranscriptStore.getState().bySession[sessionId] === undefined) {
			void loadSessionBundle(sessionId).catch((error) => {
				console.error("切换会话时补拉数据失败", error);
				pushToast("warning", "toast.sessionOpenFailed", errText(error));
			});
		}
		rememberCwd(selectActiveCwd(get()));
	},

	updateSessionName: (sessionId, name) =>
		set((state) => ({
			sessions: state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s)),
		})),

	closeSession: async (sessionId, intent) => {
		try {
			// intent 只在本轮是「内存策略自动卸载」时带上，用户主动关不传（保持既有语义）
			const { closed } = await getExecutionApi(sessionId).closeSession(
				intent ? { sessionId, intent } : { sessionId },
			);
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
		const closedFile = get().sessions.find((s) => s.sessionId === sessionId)?.sessionFile;
		releaseComposerEditor(sessionId);
		sessionLoader.forget(sessionId, closedFile);
		useTranscriptStore.getState().resetSession(sessionId);
		// 频道订阅快照是「后端会话实例」的附属状态：会话关了（含 GC 卸载）就丢掉，并让在途查询作废
		useChannelSubscriptionsStore.getState().forget(sessionId);
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
			// 权限模式随会话销毁归零（后端 holder 同点位清理）
			const permissionModes = withPermissionMode(state.permissionModes, sessionId, "default");
			// LRU 打点随会话一起清（表项留着就是泄漏：只会积攒不再打开的 id）
			const lastUsedAt = { ...state.lastUsedAt };
			delete lastUsedAt[sessionId];
			return { sessions, activeSessionId, permissionModes, lastUsedAt, newSessionDraft };
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
		noteUserIntent();
		const meta = await ensureOpenSession(filePath);
		// 失败已由共享链报过一次；这里的提前返回同时保证不对用户的新选择做任何回滚
		if (!meta) return { ok: false };
		// 迟到（用户已切走）：会话确实开起来了，但**不能抢焦点** —— 调用方据此只落数据
		if (!isLatestActivation(token)) return { ok: true, latest: false, meta, token };
		set({ activeSessionId: meta.sessionId });
		// 先记 cwd 再拉数据：即便随后装载失败，用户「在用哪个项目」的事实也已经成立
		rememberCwd(meta.cwd);
		return { ok: true, latest: true, meta, token };
	},

	/**
	 * 子代理检视打开（spec D4）：同步捕获父目标 → 走统一打开链 → **只在这次导航仍是最新意图时**建立返回关系。
	 *
	 * 关键点：
	 * - 父目标在**函数入口同步捕获**（activeSessionId + sessionFile），不依赖 await 期间父会话还在焦点；
	 * - 关系提交前再核对**导航令牌**（`isLatestNavigation(token)`），不能只看 `activeSessionId === 子会话`:
	 *   同一个子会话被再点一次（比如从另一个父会话）也是更新的意图，迟到的旧提交不得覆盖它；
	 * - 失败/迟到都不挂假记录（漏箭头只是少一个入口，不会把用户带到错的父会话）。
	 */
	openSubagentSession: async (filePath) => {
		const { activeSessionId, sessions } = get();
		const parent = activeSessionId && {
			parentSessionId: activeSessionId,
			parentFile: sessions.find((s) => s.sessionId === activeSessionId)?.sessionFile,
		};
		const result = await get().openFromHistory(filePath);
		if (!parent) return result;
		if (!result.ok || !result.latest) return result;
		// 微任务窗口守卫：从 openFromHistory 返回到这里之间，用户可能又导航（甚至再开同一个子会话）
		if (!isLatestNavigation(result.token)) return result;
		useSubagentReturnStore.getState().remember(result.meta.sessionId, parent);
		return result;
	},

	/**
	 * 从子代理检视页回到父会话（spec D4）：父仍加载 → `switchSession`（不新增工作区成员、不重置实时 transcript）；
	 * 父已被 GC 卸载 → 按 `parentFile` 重开（失败路径已 toast，留在子页不做猜测性跳转）。
	 */
	returnToParent: async (childSessionId) => {
		const target = useSubagentReturnStore.getState().relations[childSessionId];
		if (!target) return false;
		if (get().sessions.some((s) => s.sessionId === target.parentSessionId)) {
			get().switchSession(target.parentSessionId);
			return true;
		}
		if (!target.parentFile) {
			pushToast("warning", "toast.subagentReturnUnavailable");
			return false;
		}
		const result = await get().openFromHistory(target.parentFile);
		return result.ok;
	},

	forkSession: async (ref) => {
		const { activeSessionId } = get();
		// 新会话页还没有消息，无可分叉（UI 上也到不了这里，防御性拦截）
		if (!activeSessionId) return undefined;
		// 分叉成功会切到新会话 = 用户导航：先领号
		const token = claimActivation();
		noteUserIntent();
		try {
			const meta = await getExecutionApi(activeSessionId).forkSession({ sessionId: activeSessionId, ref });
			// fork 出的是用户刚开的新会话 → 记入临时工作区；迟到（已不是最新意图）只入列表，不抢 activeFile
			const latest = isLatestActivation(token);
			useSessionWorkspaceStore
				.getState()
				.addMember({ file: meta.sessionFile, sessionId: meta.sessionId }, { activate: latest });
			set((state) => {
				const sessions = [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta];
				// 迟到：新会话仍进 tabs，但不抢焦点
				return latest ? { sessions, activeSessionId: meta.sessionId } : { sessions };
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
			const recalled = await getExecutionApi(activeSessionId).recallMessage({
				sessionId: activeSessionId,
				ref,
			});
			// 内容回填草稿：已有草稿文本时换行拼接（与排队取回一致），图片追加在尾部
			useDraftStore.getState().updateDraft(activeSessionId, (d) =>
				appendDraftInput(d, {
					document: recalled.document ?? composerDocumentFromText(recalled.text),
					images: recalled.images,
				}),
			);
			// 重建消息流 + 队列/todo 对齐（同 fork 的恢复套路；会话 meta 不变无需更新）
			await loadSessionBundle(activeSessionId);
			if (get().activeSessionId === activeSessionId)
				window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT, { detail: { moveToEnd: true } }));
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

	loadModels: async (environment = currentEnvironment(get())) => {
		const key = environmentKey(environment);
		const seq = (modelLoads.get(key) ?? 0) + 1;
		modelLoads.set(key, seq);
		try {
			const models = await getExecutionApi(environment).listModels();
			// 复用上次使用的模型/思考级别（失效则回退到第一个可用模型）
			const saved = environment.kind === "local" ? await getPi().loadUiState() : null;
			if (modelLoads.get(key) !== seq) return;
			set((state) => ({ modelsByEnvironment: { ...state.modelsByEnvironment, [key]: models } }));
			if (!sameEnvironment(environment, currentEnvironment(get()))) return;
			const savedModel =
				saved?.lastUsedModel &&
				models.some(
					(m) => m.provider === saved.lastUsedModel?.provider && m.id === saved.lastUsedModel?.modelId,
				)
					? saved.lastUsedModel
					: null;
			const current = environment.kind === "local" ? get().lastUsedModel : get().newSessionDraft?.model;
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
			sync: (sessionId) => getExecutionApi(sessionId).setModel({ sessionId, provider, modelId }),
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
			sync: (sessionId) => getExecutionApi(sessionId).setThinkingLevel({ sessionId, level }),
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
			await getExecutionApi(sessionId).setPermissionMode({ sessionId, mode });
			// D7：IPC 成功才记（失败回滚不记）；传 default 则会删键
			if (environmentEntityRef(sessionId).environment.kind === "local") {
				useUiPreferencesStore.getState().rememberPermissionMode(sessionId, mode);
			}
		} catch (error) {
			set((state) => ({ permissionModes: withPermissionMode(state.permissionModes, sessionId, previous) }));
			console.error("切换权限模式失败", error);
			pushToast("warning", "toast.permissionModeFailed", errText(error));
		}
	},
}));

const sessionLoader = createSessionLoader({
	isOpen: (sessionId) => useSessionsStore.getState().sessions.some((s) => s.sessionId === sessionId),
	landMeta: (meta) =>
		commitSessionState((state) => ({
			sessions: [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta],
			lastUsedAt: { ...state.lastUsedAt, [meta.sessionId]: Date.now() },
		})),
	readPermissionMode: (sessionId) => useSessionsStore.getState().permissionModes[sessionId],
	writePermissionMode: applyBackendPermissionMode,
});
// Bind the coordinator methods directly; no private forwarding facade.
const { loadSessionBundle, restorePermissionMode, ensureOpenSession } = sessionLoader;

const remoteRecovery = new Map<string, number>();
export function invalidateEnvironmentSessions(environment: EnvironmentRef): number {
	const key = environmentKey(environment);
	const generation = (remoteRecovery.get(key) ?? 0) + 1;
	remoteRecovery.set(key, generation);
	pauseEnvironmentEvents(environment);
	invalidateInteractions(environment);
	for (const meta of useSessionsStore.getState().sessions) {
		if (!sameEnvironment(environmentEntityRef(meta.sessionId).environment, environment)) continue;
		sessionLoader.forget(meta.sessionId, meta.sessionFile);
		beginSessionBaseline(meta.sessionId);
	}
	return generation;
}
export async function synchronizeEnvironmentSessions(
	environment: EnvironmentRef,
	generation: number,
): Promise<void> {
	const key = environmentKey(environment);
	const [summaries] = await Promise.all([
		getExecutionApi(environment).getLoadedSessions(),
		synchronizeInteractions(environment),
	]);
	if (remoteRecovery.get(key) !== generation) return;
	const old = useSessionsStore.getState();
	const active = old.activeSessionId;
	const previousActive = old.sessions.find((meta) => meta.sessionId === active);
	const loadedIds = new Set(summaries.map((summary) => summary.meta.sessionId));
	for (const meta of old.sessions) {
		if (
			!sameEnvironment(environmentEntityRef(meta.sessionId).environment, environment) ||
			loadedIds.has(meta.sessionId)
		)
			continue;
		forgetSessionBoundary(meta.sessionId);
		useTranscriptStore.setState((state) => {
			const previous = state.bySession[meta.sessionId];
			if (!previous) return state;
			return {
				bySession: {
					...state.bySession,
					[meta.sessionId]: {
						...previous,
						streaming: null,
						agentActive: false,
						compacting: false,
						phase: "idle",
						followUpQueue: [],
						retrying: null,
						pendingLlmError: null,
						pendingPermissions: [],
						pendingDialogs: [],
					},
				},
			};
		});
	}
	const tokens = new Map(
		summaries.map((summary) => [
			summary.meta.sessionId,
			pendingSessionBaselineToken(summary.meta.sessionId) ?? beginSessionBaseline(summary.meta.sessionId),
		]),
	);
	commitSessionState((state) => ({
		sessions: [
			...state.sessions.filter(
				(meta) => !sameEnvironment(environmentEntityRef(meta.sessionId).environment, environment),
			),
			...summaries.map((summary) => summary.meta),
		],
	}));
	for (const summary of summaries) {
		const id = summary.meta.sessionId;
		finishSessionBaseline(id, tokens.get(id) as number, summary.sequence, () => {
			useTranscriptStore.setState((state) => {
				const previous = state.bySession[id];
				return {
					bySession: {
						...state.bySession,
						[id]: {
							...(previous ?? { ...emptyTranscript(), pendingPermissions: [], pendingDialogs: [] }),
							streaming: null,
							agentActive: summary.streaming,
							compacting: summary.compacting,
							phase: previous?.pendingPermissions.length
								? "awaiting_permission"
								: summary.streaming
									? "streaming"
									: "idle",
							followUpQueue: summary.followUpQueue,
						},
					},
				};
			});
			applyBackendPermissionMode(id, summary.permissionMode);
		});
	}
	resumeEnvironmentEvents(environment);
	if (active && previousActive && sameEnvironment(environmentEntityRef(active).environment, environment)) {
		if (!summaries.some((summary) => summary.meta.sessionId === active) && previousActive.sessionFile)
			await ensureOpenSession(previousActive.sessionFile, { loadBundle: false });
		if (
			remoteRecovery.get(key) === generation &&
			useSessionsStore.getState().sessions.some((meta) => meta.sessionId === active)
		)
			await loadSessionBundle(active);
	}
}

/**
 * 工作区 `activeFile` 跟随当前会话：**唯一同步点**。
 *
 * activeFile 的语义是「重启后回到哪个成员」，所以只在当前会话确实是工作区成员时指向它；浏览新会话页、
 * 只读子代理检视等非成员页面时落 null（spec）。它**只管指针，绝不在这里加成员** —— 内存策略的卸载/
 * 重建、事件驱动的内部切换也会改 activeSessionId，订阅式加入会把用户已 × 掉的会话复活（spec 硬要求）。
 *
 * 放在本模块而不是 workspace 侧：依赖方向是 sessions → session-workspace，反向订阅会成模块环。
 */
useSessionsStore.subscribe((state, prev) => {
	if (state.activeSessionId === prev.activeSessionId) return;
	const { members, setActive } = useSessionWorkspaceStore.getState();
	setActive(members.find((m) => m.sessionId === state.activeSessionId)?.file ?? null);
});
