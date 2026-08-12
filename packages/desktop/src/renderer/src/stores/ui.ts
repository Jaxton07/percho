import { create } from "zustand";

export type AppView = "chat" | "projects";

interface UiStore {
	view: AppView;
	setView: (view: AppView) => void;
	/** todo 面板展开态（按会话，切换会话互不影响；不含持久化） */
	todoExpanded: Record<string, boolean>;
	toggleTodoExpanded: (sessionId: string) => void;
}

export const useUiStore = create<UiStore>((set) => ({
	view: "chat",
	setView: (view) => set({ view }),
	todoExpanded: {},
	toggleTodoExpanded: (sessionId) =>
		set((state) => ({
			todoExpanded: { ...state.todoExpanded, [sessionId]: !state.todoExpanded[sessionId] },
		})),
}));
