import type { BackgroundSettings, ThemeMode } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";

export type ResolvedTheme = "light" | "dark";

const DEFAULT_BACKGROUND: BackgroundSettings = { image: null, dim: 0.8 };
const media = window.matchMedia("(prefers-color-scheme: dark)");

/** 自定义背景图 URL（main 进程 pi-bg 协议提供，只读 userData/backgrounds/） */
export const backgroundImageUrl = (name: string): string => `pi-bg://background/${encodeURIComponent(name)}`;

interface ThemeStore {
	mode: ThemeMode;
	resolved: ResolvedTheme;
	background: BackgroundSettings;
	/** 启动时从 ui-state.json 恢复主题/背景（main.tsx 在 render 前 await，防主题闪烁） */
	init: () => Promise<void>;
	setMode: (mode: ThemeMode) => void;
	pickBackground: () => Promise<void>;
	clearBackground: () => void;
	setBackgroundDim: (dim: number) => void;
}

function applyDom(resolved: ResolvedTheme, background: BackgroundSettings): void {
	document.documentElement.dataset.theme = resolved;
	document.documentElement.dataset.hasBg = background.image ? "true" : "false";
}

export const useThemeStore = create<ThemeStore>((set, get) => {
	// system 模式下跟随系统深浅色变化
	media.addEventListener("change", () => {
		const { mode, background } = get();
		if (mode !== "system") return;
		const resolved: ResolvedTheme = media.matches ? "dark" : "light";
		applyDom(resolved, background);
		set({ resolved });
	});

	const apply = (mode: ThemeMode, background: BackgroundSettings) => {
		const resolved: ResolvedTheme = mode === "system" ? (media.matches ? "dark" : "light") : mode;
		applyDom(resolved, background);
		set({ mode, resolved, background });
	};

	const persist = () => {
		const { mode, background } = get();
		getPi().saveUiState({ theme: mode, background }).catch((error) => console.error("ui-state 持久化失败", error));
	};

	return {
		mode: "system",
		resolved: media.matches ? "dark" : "light",
		background: DEFAULT_BACKGROUND,

		init: async () => {
			const saved = await getPi()
				.loadUiState()
				.catch(() => null);
			apply(saved?.theme ?? "system", saved?.background ?? DEFAULT_BACKGROUND);
		},

		setMode: (mode) => {
			apply(mode, get().background);
			persist();
		},

		pickBackground: async () => {
			const name = await getPi().pickBackgroundImage();
			if (!name) return;
			apply(get().mode, { ...get().background, image: name });
			persist();
		},

		clearBackground: () => {
			apply(get().mode, { ...get().background, image: null });
			persist();
		},

		setBackgroundDim: (dim) => {
			apply(get().mode, { ...get().background, dim });
			persist();
		},
	};
});
