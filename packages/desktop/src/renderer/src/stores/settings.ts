import type { CustomProviderInput, ProviderInfo, ProviderTestResult } from "@pi-desktop/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { useSessionsStore } from "./sessions";

export type SettingsCategory = "general" | "providers" | "skills" | "mcp" | "extensions";

interface SettingsStore {
	open: boolean;
	/** 当前设置分类（/settings 命令可定位到指定面板） */
	category: SettingsCategory;
	providers: ProviderInfo[];
	loading: boolean;
	/** providerId → 测试结果（"testing" 表示进行中） */
	testResults: Record<string, ProviderTestResult | "testing">;
	error: string | null;
	setOpen: (open: boolean) => void;
	/** 打开并（可选）定位到指定分类 */
	openWith: (category?: SettingsCategory) => void;
	setCategory: (category: SettingsCategory) => void;
	refresh: () => Promise<void>;
	saveKey: (providerId: string, key: string) => Promise<void>;
	removeCredential: (providerId: string) => Promise<void>;
	addCustom: (input: CustomProviderInput) => Promise<void>;
	removeCustom: (providerId: string) => Promise<void>;
	test: (providerId: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => {
	/** 变更后刷新 provider 列表与模型选择器数据 */
	const afterMutation = async () => {
		await get().refresh();
		await useSessionsStore.getState().loadModels();
	};

	return {
		open: false,
		category: "providers",
		providers: [],
		loading: false,
		testResults: {},
		error: null,

		setOpen: (open) => {
			set({ open, testResults: {}, error: null });
			if (open) void get().refresh();
		},

		openWith: (category) => {
			set((state) => ({ category: category ?? state.category, open: true, testResults: {}, error: null }));
			void get().refresh();
		},

		setCategory: (category) => set({ category }),

		refresh: async () => {
			set({ loading: true });
			try {
				const providers = await getPi().listProviders();
				set({ providers, loading: false, error: null });
			} catch (error) {
				set({ loading: false, error: error instanceof Error ? error.message : String(error) });
			}
		},

		saveKey: async (providerId, key) => {
			try {
				await getPi().saveApiKey(providerId, key);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		},

		removeCredential: async (providerId) => {
			try {
				await getPi().removeCredential(providerId);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		},

		addCustom: async (input) => {
			try {
				await getPi().addCustomProvider(input);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
		},

		removeCustom: async (providerId) => {
			try {
				await getPi().removeCustomProvider(providerId);
				await afterMutation();
			} catch (error) {
				set({ error: error instanceof Error ? error.message : String(error) });
			}
		},

		test: async (providerId) => {
			set((state) => ({ testResults: { ...state.testResults, [providerId]: "testing" } }));
			try {
				const result = await getPi().testProvider(providerId);
				set((state) => ({ testResults: { ...state.testResults, [providerId]: result } }));
			} catch (error) {
				set((state) => ({
					testResults: {
						...state.testResults,
						[providerId]: { ok: false, error: error instanceof Error ? error.message : String(error) },
					},
				}));
			}
		},
	};
});
