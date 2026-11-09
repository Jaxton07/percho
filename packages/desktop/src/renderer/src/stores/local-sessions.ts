import type { SessionMeta } from "@percho/shared";
import { create } from "zustand";

const EMPTY_LOCAL_SESSIONS: Record<string, SessionMeta> = {};
/** Bridges a successful create/fork to the first indexed page; never infers origin from a planned file path. */
export const useLocalSessionsStore = create<{
	pending: Record<string, SessionMeta>;
	record: (meta: SessionMeta) => void;
	forget: (sessionId: string) => void;
}>((set) => ({
	pending: EMPTY_LOCAL_SESSIONS,
	record: (meta) => set((state) => ({ pending: { ...state.pending, [meta.sessionId]: meta } })),
	forget: (sessionId) =>
		set((state) => {
			if (!(sessionId in state.pending)) return state;
			const pending = { ...state.pending };
			delete pending[sessionId];
			return { pending };
		}),
}));
