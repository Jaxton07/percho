import type { AvailableModel, SavedTabs, SessionMeta } from "@pi-desktop/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { useTranscriptStore } from "./transcript";
import { messagesToUIMessages } from "./transcript-reducer";

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
	createSession: (cwd?: string) => Promise<void>;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string) => Promise<void>;
	openFromHistory: (filePath: string) => Promise<void>;
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

	createSession: async (cwd) => {
		const targetCwd = cwd ?? get().cwd;
		if (!targetCwd) return;
		try {
			const meta = await getPi().createSession({
				cwd: targetCwd,
				...get().currentModel,
				thinkingLevel: get().thinkingLevel,
			});
			set((state) => ({
				sessions: [...state.sessions, meta],
				activeSessionId: meta.sessionId,
				cwd: targetCwd,
			}));
			useTranscriptStore.getState().resetSession(meta.sessionId);
			persistTabs(get());
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	switchSession: (sessionId) => {
		set((state) => {
			const session = state.sessions.find((s) => s.sessionId === sessionId);
			return { activeSessionId: sessionId, cwd: session?.cwd ?? state.cwd };
		});
		persistTabs(get());
	},

	updateSessionName: (sessionId, name) =>
		set((state) => ({
			sessions: state.sessions.map((s) => (s.sessionId === sessionId ? { ...s, name } : s)),
		})),

	closeSession: async (sessionId) => {
		await getPi().closeSession(sessionId);
		useTranscriptStore.getState().resetSession(sessionId);
		set((state) => {
			const sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
			const activeSessionId =
				state.activeSessionId === sessionId ? (sessions[0]?.sessionId ?? null) : state.activeSessionId;
			return { sessions, activeSessionId };
		});
		persistTabs(get());
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
				const history = await getPi().getSessionMessages(meta.sessionId);
				useTranscriptStore.getState().loadHistory(meta.sessionId, messagesToUIMessages(history));
				opened.push(meta);
				if (meta.sessionFile === saved.activeFile) activeId = meta.sessionId;
			} catch {
				// 会话文件已被删除等：跳过
			}
		}
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
		if (cwd) set({ cwd });
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

	setCurrentModel: async (provider, modelId) => {
		const { activeSessionId } = get();
		set({ currentModel: { provider, modelId } });
		void getPi().saveUiState({ currentModel: { provider, modelId }, thinkingLevel: get().thinkingLevel });
		if (activeSessionId) {
			try {
				await getPi().setModel(activeSessionId, provider, modelId);
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		}
	},

	setThinkingLevel: async (level) => {
		const { activeSessionId, currentModel } = get();
		set({ thinkingLevel: level });
		void getPi().saveUiState({ currentModel, thinkingLevel: level });
		if (activeSessionId) {
			try {
				await getPi().setThinkingLevel(activeSessionId, level);
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		}
	},
}));
