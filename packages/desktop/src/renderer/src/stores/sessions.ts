import type { AvailableModel, SavedTabs, SessionMeta } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { useTranscriptStore } from "./transcript";
import { messagesToUIMessages } from "./transcript-reducer";

/** 草稿会话 id 前缀：新会话 tab 的占位条目，只存在于 renderer 内存，后端永远不会看到 */
export const DRAFT_SESSION_PREFIX = "draft:";

export function isDraftSessionId(sessionId: string | null | undefined): boolean {
	return typeof sessionId === "string" && sessionId.startsWith(DRAFT_SESSION_PREFIX);
}

/** 顶栏打开的会话持久化（重启恢复用）；由主进程写 userData/tabs.json，不依赖 renderer localStorage */
function persistTabs(state: Pick<SessionsStore, "sessions" | "activeSessionId">): void {
	try {
		void getPi().saveTabs({
			files: [...new Set(state.sessions.map((s) => s.sessionFile).filter((f): f is string => Boolean(f)))],
			activeFile: state.sessions.find((s) => s.sessionId === state.activeSessionId)?.sessionFile ?? null,
		});
	} catch {
		// 持久化失败静默（不影响主流程）
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
	createSession: (cwd?: string, replaceDraftId?: string) => Promise<void>;
	/** 新建草稿会话 tab：不触后端、不落盘（空 tab 重启后自动消失），发送首条消息时才用其 cwd 真正创建 */
	createDraftSession: (cwd?: string) => void;
	/** 设置新会话的目标项目目录；活跃 tab 是 draft 时同步更新其条目（切 tab 往返不丢选择） */
	setDraftCwd: (cwd: string) => void;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string) => Promise<void>;
	openFromHistory: (filePath: string) => Promise<void>;
	/** 在指定 assistant 消息处分叉：新会话以新 tab 打开并切换过去（原会话保留原样） */
	forkSession: (ref: { entryId?: string; text?: string }) => Promise<void>;
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

	setDraftCwd: (cwd) =>
		set((state) => {
			const active = state.sessions.find((s) => s.sessionId === state.activeSessionId);
			if (active && isDraftSessionId(active.sessionId)) {
				return {
					cwd,
					sessions: state.sessions.map((s) => (s.sessionId === active.sessionId ? { ...s, cwd } : s)),
				};
			}
			return { cwd };
		}),

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

	closeSession: async (sessionId) => {
		const isDraft = isDraftSessionId(sessionId);
		// draft 没有后端会话，纯本地移除
		if (!isDraft) await getPi().closeSession(sessionId);
		useTranscriptStore.getState().resetSession(sessionId);
		set((state) => {
			const sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
			const activeSessionId =
				state.activeSessionId === sessionId ? (sessions[0]?.sessionId ?? null) : state.activeSessionId;
			return { sessions, activeSessionId };
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
			const history = await getPi().getSessionMessages(meta.sessionId);
			useTranscriptStore.getState().loadHistory(meta.sessionId, messagesToUIMessages(history));
			const followUpQueue = await getPi().getFollowUpMessages(meta.sessionId);
			useTranscriptStore.getState().setFollowUpQueue(meta.sessionId, followUpQueue);
			const todos = await getPi().getTodos(meta.sessionId);
			useTranscriptStore.getState().loadTodos(meta.sessionId, todos);
			persistTabs(get());
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	forkSession: async (ref) => {
		const { activeSessionId } = get();
		// draft 还没有消息，无可分叉（UI 上也到不了这里，防御性拦截）
		if (!activeSessionId || isDraftSessionId(activeSessionId)) return;
		try {
			const meta = await getPi().forkSession(activeSessionId, ref);
			set((state) => ({
				sessions: [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta],
				activeSessionId: meta.sessionId,
			}));
			const history = await getPi().getSessionMessages(meta.sessionId);
			useTranscriptStore.getState().loadHistory(meta.sessionId, messagesToUIMessages(history));
			const followUpQueue = await getPi().getFollowUpMessages(meta.sessionId);
			useTranscriptStore.getState().setFollowUpQueue(meta.sessionId, followUpQueue);
			const todos = await getPi().getTodos(meta.sessionId);
			useTranscriptStore.getState().loadTodos(meta.sessionId, todos);
			persistTabs(get());
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
		// 每个会话的历史/队列/todo 三次 IPC 并行取（原先 3×N 次串行往返，首启时长期占住主线程 → 开屏掉帧）
		await Promise.all(
			opened.map(async (meta) => {
				try {
					const [history, followUpQueue, todos] = await Promise.all([
						getPi().getSessionMessages(meta.sessionId),
						getPi().getFollowUpMessages(meta.sessionId),
						getPi().getTodos(meta.sessionId),
					]);
					useTranscriptStore.getState().loadHistory(meta.sessionId, messagesToUIMessages(history));
					useTranscriptStore.getState().setFollowUpQueue(meta.sessionId, followUpQueue);
					useTranscriptStore.getState().loadTodos(meta.sessionId, todos);
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
			set({
				models,
				currentModel:
					savedModel ?? current ?? (fallback ? { provider: fallback.provider, modelId: fallback.id } : null),
				thinkingLevel: saved?.thinkingLevel ?? get().thinkingLevel,
			});
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	/** 切换当前会话的模型：更新全局默认（新会话用）+ 当前会话（只影响该会话），并同步 SDK */
	setCurrentModel: async (provider, modelId) => {
		const { activeSessionId } = get();
		set((state) => ({
			currentModel: { provider, modelId },
			sessions: state.sessions.map((s) =>
				s.sessionId === activeSessionId ? { ...s, model: { provider, modelId } } : s,
			),
		}));
		void getPi().saveUiState({ currentModel: { provider, modelId }, thinkingLevel: get().thinkingLevel });
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
		void getPi().saveUiState({ currentModel, thinkingLevel: level });
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
