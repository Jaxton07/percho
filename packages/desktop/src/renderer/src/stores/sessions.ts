import type { AvailableModel, SessionMeta } from "@pi-desktop/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { useTranscriptStore } from "./transcript";

interface SessionsStore {
	sessions: SessionMeta[];
	activeSessionId: string | null;
	cwd: string | null;
	models: AvailableModel[];
	currentModel: { provider: string; modelId: string } | null;
	error: string | null;
	createSession: (cwd?: string) => Promise<void>;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string) => Promise<void>;
	openFromHistory: (filePath: string) => Promise<void>;
	/** 自动命名等事件带来的标题变更 */
	updateSessionName: (sessionId: string, name: string | undefined) => void;
	pickDirectory: () => Promise<void>;
	loadModels: () => Promise<void>;
	setCurrentModel: (provider: string, modelId: string) => Promise<void>;
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
	sessions: [],
	activeSessionId: null,
	cwd: null,
	models: [],
	currentModel: null,
	error: null,

	createSession: async (cwd) => {
		const targetCwd = cwd ?? get().cwd;
		if (!targetCwd) return;
		try {
			const meta = await getPi().createSession({ cwd: targetCwd, ...get().currentModel });
			set((state) => ({
				sessions: [...state.sessions, meta],
				activeSessionId: meta.sessionId,
				cwd: targetCwd,
			}));
			useTranscriptStore.getState().resetSession(meta.sessionId);
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	switchSession: (sessionId) =>
		set((state) => {
			const session = state.sessions.find((s) => s.sessionId === sessionId);
			return { activeSessionId: sessionId, cwd: session?.cwd ?? state.cwd };
		}),

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
	},

	openFromHistory: async (filePath) => {
		try {
			const meta = await getPi().openSession(filePath);
			set((state) => ({
				sessions: [...state.sessions.filter((s) => s.sessionId !== meta.sessionId), meta],
				activeSessionId: meta.sessionId,
				cwd: meta.cwd,
			}));
			useTranscriptStore.getState().resetSession(meta.sessionId);
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	pickDirectory: async () => {
		const cwd = await getPi().pickDirectory();
		if (cwd) set({ cwd });
	},

	loadModels: async () => {
		try {
			const models = await getPi().listModels();
			set({ models });
			const current = get().currentModel;
			if (!current && models[0]) {
				set({ currentModel: { provider: models[0].provider, modelId: models[0].id } });
			}
		} catch (error) {
			set({ error: error instanceof Error ? error.message : String(error) });
		}
	},

	setCurrentModel: async (provider, modelId) => {
		const { activeSessionId } = get();
		set({ currentModel: { provider, modelId } });
		if (activeSessionId) {
			try {
				await getPi().setModel(activeSessionId, provider, modelId);
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		}
	},
}));
