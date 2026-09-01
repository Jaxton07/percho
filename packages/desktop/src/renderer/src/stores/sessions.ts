import type { AvailableModel, SavedTabs, SessionMeta } from "@percho/shared";
import { messagesToUIMessages } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { clampThinkingLevel } from "../lib/thinking";
import { COMPOSER_FOCUS_EVENT, useDraftStore } from "./drafts";
import { pushToast } from "./toasts";
import { useTranscriptStore } from "./transcript";

/** 草稿会话 id 前缀：新会话 tab 的占位条目，只存在于 renderer 内存，后端永远不会看到 */
export const DRAFT_SESSION_PREFIX = "draft:";

export function isDraftSessionId(sessionId: string | null | undefined): boolean {
	return typeof sessionId === "string" && sessionId.startsWith(DRAFT_SESSION_PREFIX);
}

/**
 * 打开会话时同步三件套：消息历史（可选跳过 live 态）、排队队列、todo 面板。
 * 取数并行（三写各写 store 不同字段，无交叉读），应用顺序保持 history → queue → todos。
 */
async function loadSessionBundle(sessionId: string, opts?: { skipHistoryIfLive?: boolean }): Promise<void> {
	// skip 判定在入口一次性取值：并行发起 IPC 前先确定是否跳过历史（agent 运行中保流式态，见 openFromHistory 注释）
	const skipHistory =
		opts?.skipHistoryIfLive === true &&
		useTranscriptStore.getState().bySession[sessionId]?.agentActive === true;
	const [history, followUpQueue, todos] = await Promise.all([
		skipHistory ? Promise.resolve(null) : getPi().getSessionMessages(sessionId),
		getPi().getFollowUpMessages(sessionId),
		getPi().getTodos(sessionId),
	]);
	const t = useTranscriptStore.getState();
	if (history) t.loadHistory(sessionId, messagesToUIMessages(history));
	t.setFollowUpQueue(sessionId, followUpQueue);
	t.loadTodos(sessionId, todos);
}

/** toast detail 展示截断（原始错误文本超出只留首段） */
function errText(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	if (!message) return undefined;
	return message.length > 140 ? `${message.slice(0, 140)}…` : message;
}

/** 顶栏打开的会话持久化（重启恢复用）；由主进程写 userData/tabs.json，不依赖 renderer localStorage */
function persistTabs(state: Pick<SessionsStore, "sessions" | "activeSessionId">): void {
	try {
		getPi()
			.saveTabs({
				files: [...new Set(state.sessions.map((s) => s.sessionFile).filter((f): f is string => Boolean(f)))],
				activeFile: state.sessions.find((s) => s.sessionId === state.activeSessionId)?.sessionFile ?? null,
			})
			.catch((error) => {
				console.error("tabs 持久化失败", error);
				pushToast("warning", "toast.tabsSaveFailed", errText(error));
			});
	} catch (error) {
		console.error("tabs 持久化失败", error);
		pushToast("warning", "toast.tabsSaveFailed", errText(error));
	}
}

interface SessionsStore {
	sessions: SessionMeta[];
	activeSessionId: string | null;
	cwd: string | null;
	models: AvailableModel[];
	currentModel: { provider: string; modelId: string } | null;
	thinkingLevel: string;
	error: string | null;
	/** 项目信任决策完成计数：ensureProjectTrust 应答后 +1，驱动 draft 斜杠菜单按新决策重拉 */
	trustVersion: number;
	createSession: (cwd?: string, replaceDraftId?: string) => Promise<void>;
	/** 新建草稿会话 tab：不触后端、不落盘（空 tab 重启后自动消失），发送首条消息时才用其 cwd 真正创建 */
	createDraftSession: (cwd?: string) => void;
	/** 设置新会话的目标项目目录；活跃 tab 是 draft 时同步更新其条目（切 tab 往返不丢选择） */
	setDraftCwd: (cwd: string) => void;
	switchSession: (sessionId: string) => void;
	/** 拖拽排序顶栏胶囊：调整 sessions 数组顺序并落盘（tabs.json 的 files 本就保序，重启按新序恢复） */
	reorderSessions: (fromId: string, toId: string) => void;
	closeSession: (sessionId: string) => Promise<void>;
	openFromHistory: (filePath: string) => Promise<void>;
	/** 在指定 assistant 消息处分叉：新会话以新 tab 打开并切换过去（原会话保留原样）；成功返回新 sessionId */
	forkSession: (ref: { entryId?: string; text?: string }) => Promise<string | undefined>;
	/** 撤回一条用户消息：会话回退到该消息之前，文本/图片放回输入框草稿继续编辑 */
	recallMessage: (ref: { entryId?: string; text?: string; timestamp?: number }) => Promise<void>;
	/** 重启后恢复上次打开的顶栏会话 */
	restoreTabs: () => Promise<void>;
	/** 自动命名等事件带来的标题变更 */
	updateSessionName: (sessionId: string, name: string | undefined) => void;
	pickDirectory: () => Promise<void>;
	loadModels: () => Promise<void>;
	setCurrentModel: (provider: string, modelId: string) => Promise<void>;
	setThinkingLevel: (level: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
	sessions: [],
	activeSessionId: null,
	cwd: null,
	models: [],
	currentModel: null,
	thinkingLevel: "medium",
	error: null,
	trustVersion: 0,

	createSession: async (cwd, replaceDraftId) => {
		const targetCwd = cwd ?? get().cwd;
		if (!targetCwd) return;
		try {
			const meta = await getPi().createSession({
				cwd: targetCwd,
				...get().currentModel,
				thinkingLevel: get().thinkingLevel,
			});
			set((state) => ({
				// draft 转正式会话：原地替换保持 tab 位置；普通新建则追加
				sessions: replaceDraftId
					? state.sessions.map((s) => (s.sessionId === replaceDraftId ? meta : s))
					: [...state.sessions, meta],
				activeSessionId: meta.sessionId,
				cwd: targetCwd,
			}));
			useTranscriptStore.getState().resetSession(meta.sessionId);
			persistTabs(get());
		} catch (error) {
			// 失败时 draft tab 保留，用户重试即可
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	createDraftSession: (cwd) => {
		const targetCwd = cwd ?? get().cwd;
		if (!targetCwd) return;
		// 信任前置：未决项目立即弹窗（结果落 trust.json），draft 拉斜杠命令/转正建会话直接命中缓存
		void getPi()
			.ensureProjectTrust(targetCwd)
			.then(() => set((s) => ({ trustVersion: s.trustVersion + 1 })))
			.catch((error) => {
				console.error("项目信任检查失败", error);
				pushToast("warning", "toast.trustFailed", errText(error));
			});
		const now = Date.now();
		const draft: SessionMeta = {
			sessionId: `${DRAFT_SESSION_PREFIX}${crypto.randomUUID()}`,
			cwd: targetCwd,
			model: get().currentModel,
			thinkingLevel: get().thinkingLevel,
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
		// 不 persistTabs：draft 无 sessionFile 本就会被过滤，tabs.json 保持指向最近的真实会话
	},

	setDraftCwd: (cwd) => {
		// 同 createDraftSession：cwd 变化即前置信任决策
		void getPi()
			.ensureProjectTrust(cwd)
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
		// 切到 draft 不落盘：tabs.json 保持指向最近的真实会话（draft 重启后本就会消失）
		if (!isDraftSessionId(sessionId)) persistTabs(get());
	},

	updateSessionName: (sessionId, name) =>
		set((state) => ({
			sessions: state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s)),
		})),

	reorderSessions: (fromId, toId) => {
		const { sessions } = get();
		const from = sessions.findIndex((s) => s.sessionId === fromId);
		const to = sessions.findIndex((s) => s.sessionId === toId);
		if (from < 0 || to < 0 || from === to) return;
		const next = [...sessions];
		const [moved] = next.splice(from, 1);
		if (!moved) return;
		next.splice(to, 0, moved);
		set({ sessions: next });
		// draft 无 sessionFile 会被过滤，落盘的是真实会话的新视觉顺序
		persistTabs(get());
	},

	closeSession: async (sessionId) => {
		const isDraft = isDraftSessionId(sessionId);
		// draft 没有后端会话，纯本地移除
		if (!isDraft) {
			try {
				await getPi().closeSession(sessionId);
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
			return { sessions, activeSessionId, cwd };
		});
		if (!isDraft) persistTabs(get());
	},

	openFromHistory: async (filePath) => {
		try {
			const meta = await getPi().openSession(filePath);
			set((state) => ({
				sessions: [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta],
				activeSessionId: meta.sessionId,
				cwd: meta.cwd,
			}));
			// 运行中子会话的事件已按其 sessionId 实时转发；保留已有流式态，
			// 否则会在点击卡片时把 agent_start 建立的进度视图重置为静态历史。
			await loadSessionBundle(meta.sessionId, { skipHistoryIfLive: true });
			persistTabs(get());
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	forkSession: async (ref) => {
		const { activeSessionId } = get();
		// draft 还没有消息，无可分叉（UI 上也到不了这里，防御性拦截）
		if (!activeSessionId || isDraftSessionId(activeSessionId)) return undefined;
		try {
			const meta = await getPi().forkSession(activeSessionId, ref);
			set((state) => ({
				sessions: [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta],
				activeSessionId: meta.sessionId,
			}));
			await loadSessionBundle(meta.sessionId);
			persistTabs(get());
			return meta.sessionId;
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
			return undefined;
		}
	},

	recallMessage: async (ref) => {
		const { activeSessionId } = get();
		// draft 还没有消息，无可撤回（UI 上也到不了这里，防御性拦截）
		if (!activeSessionId || isDraftSessionId(activeSessionId)) return;
		try {
			const recalled = await getPi().recallMessage(activeSessionId, ref);
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
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	restoreTabs: async () => {
		const saved: SavedTabs | null = await getPi().loadTabs();
		if (!saved || saved.files.length === 0) return;
		const opened: SessionMeta[] = [];
		const seen = new Set<string>();
		let activeId: string | null = null;
		for (const file of saved.files) {
			try {
				const meta = await getPi().openSession(file);
				if (seen.has(meta.sessionId)) continue;
				seen.add(meta.sessionId);
				opened.push(meta);
				if (meta.sessionFile === saved.activeFile) activeId = meta.sessionId;
			} catch {
				// 会话文件已被删除等：跳过
			}
		}
		// 每个会话三件套并行取（原先 3×N 次串行往返，首启时长期占住主线程 → 开屏掉帧）
		await Promise.all(
			opened.map(async (meta) => {
				try {
					await loadSessionBundle(meta.sessionId);
				} catch {
					// 单会话数据取不到不影响其它 tab 恢复
				}
			}),
		);
		if (opened.length === 0) return;
		const lastOpened = opened[opened.length - 1];
		if (!lastOpened) return;
		set((state) => {
			const existing = state.sessions.filter((s) => !opened.some((o) => o.sessionId === s.sessionId));
			const sessions = [...existing, ...opened];
			const activeSessionId = activeId ?? lastOpened.sessionId;
			const cwd = sessions.find((s) => s.sessionId === activeSessionId)?.cwd ?? null;
			return { sessions, activeSessionId, cwd };
		});
		persistTabs(get());
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
				saved?.currentModel &&
				models.some(
					(m) => m.provider === saved.currentModel?.provider && m.id === saved.currentModel?.modelId,
				)
					? saved.currentModel
					: null;
			const current = get().currentModel;
			const fallback = models.find((m) => m.authed) ?? models[0];
			const nextCurrentModel =
				savedModel ?? current ?? (fallback ? { provider: fallback.provider, modelId: fallback.id } : null);
			// 持久化级别也按当前选中模型的能力夹紧（避免恢复后 store 与 UI/SDK 实际生效值不一致）
			const nextModelRecord = nextCurrentModel
				? models.find((m) => m.provider === nextCurrentModel.provider && m.id === nextCurrentModel.modelId)
				: undefined;
			const supportedLevels = nextModelRecord?.thinkingLevels;
			const rawLevel = saved?.thinkingLevel ?? get().thinkingLevel;
			const clampedLevel =
				supportedLevels && supportedLevels.length > 0
					? clampThinkingLevel(rawLevel, supportedLevels)
					: rawLevel;
			set({
				models,
				currentModel: nextCurrentModel,
				thinkingLevel: clampedLevel,
			});
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	/** 切换当前会话的模型：更新全局默认（新会话用）+ 当前会话（只影响该会话），并同步 SDK */
	setCurrentModel: async (provider, modelId) => {
		const { activeSessionId } = get();
		// 思考深度跟随新模型能力收缩（就近向上找，找不到再取最高档，与 UI 一致）
		const nextModel = get().models.find((m) => m.provider === provider && m.id === modelId);
		let thinkingLevel: string = get().thinkingLevel;
		if (nextModel?.thinkingLevels && nextModel.thinkingLevels.length > 0) {
			thinkingLevel = clampThinkingLevel(thinkingLevel, nextModel.thinkingLevels);
		}
		set((state) => ({
			currentModel: { provider, modelId },
			thinkingLevel,
			sessions: state.sessions.map((s) =>
				s.sessionId === activeSessionId ? { ...s, model: { provider, modelId }, thinkingLevel } : s,
			),
		}));
		getPi()
			.saveUiState({ currentModel: { provider, modelId }, thinkingLevel })
			.catch((error) => {
				console.error("ui-state 持久化失败", error);
				pushToast("warning", "toast.uiStateSaveFailed", errText(error));
			});
		// draft 无后端会话：模型选择只作为全局默认，创建时随 createSession 生效
		if (activeSessionId && !isDraftSessionId(activeSessionId)) {
			try {
				await getPi().setModel(activeSessionId, provider, modelId);
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		}
	},

	/** 切换当前会话的思考深度：更新全局默认 + 当前会话（只影响该会话），并同步 SDK */
	setThinkingLevel: async (level) => {
		const { activeSessionId, currentModel } = get();
		set((state) => ({
			thinkingLevel: level,
			sessions: state.sessions.map((s) =>
				s.sessionId === activeSessionId ? { ...s, thinkingLevel: level } : s,
			),
		}));
		getPi()
			.saveUiState({ currentModel, thinkingLevel: level })
			.catch((error) => console.error("ui-state 持久化失败", error));
		// draft 无后端会话：同上，仅作全局默认
		if (activeSessionId && !isDraftSessionId(activeSessionId)) {
			try {
				await getPi().setThinkingLevel(activeSessionId, level);
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		}
	},
}));
