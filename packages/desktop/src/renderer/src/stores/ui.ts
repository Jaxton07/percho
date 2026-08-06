import { create } from "zustand";

export type AppView = "chat" | "projects";

interface UiStore {
	view: AppView;
	setView: (view: AppView) => void;
}

export const useUiStore = create<UiStore>((set) => ({
	view: "chat",
	setView: (view) => set({ view }),
}));
