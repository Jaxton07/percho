import type { LoginAuthPrompt, ProviderInfo } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { useSessionsStore } from "./sessions";
import { useSettingsStore } from "./settings";

/** 订阅登录（OAuth）流程的 UI 状态机；事件来自 backend LoginService 桥接 */
export interface LoginFlowState {
	/** renderer 生成的流程 id（事件归属/应答/取消关联） */
	loginId: string;
	providerId: string;
	providerName: string;
	/** 最新 progress/info 文案（SDK 原文） */
	statusLine?: string;
	/** info 事件附带的链接 */
	infoLinks?: readonly { url: string; label?: string }[];
	/** 浏览器授权地址（auth_url 事件；收到时自动开一次浏览器） */
	authUrl?: { url: string; instructions?: string };
	/** 设备码（device_code 事件；SDK 侧自行轮询） */
	deviceCode?: { userCode: string; verificationUri: string; expiresInSeconds?: number };
	/** 当前挂起的输入/选择提示（应答或 prompt-cancel 后清空） */
	pendingPrompt?: { promptId: string; prompt: LoginAuthPrompt };
	/** 流程已结束但失败（保留对话框展示错误；cancelled 直接关闭不设此字段） */
	error?: string;
}

interface ProviderLoginStore {
	/** 进行中的订阅登录流程（同一时刻一个；null = 无） */
	login: LoginFlowState | null;
	/** 启动 provider 订阅登录（OAuth）；事件驱动 login 状态机，结束自动收尾 */
	startProviderLogin: (provider: ProviderInfo) => Promise<void>;
	/** 应答登录中的输入/选择提示 */
	respondLoginPrompt: (value: string) => void;
	/** 取消进行中的登录（invoke 收尾时统一清空状态） */
	cancelProviderLogin: () => void;
	/** 关闭登录对话框（错误态保留展示时用） */
	dismissLogin: () => void;
}

export const useProviderLoginStore = create<ProviderLoginStore>((set, get) => ({
	login: null,

	startProviderLogin: async (provider) => {
		if (get().login) return;
		const loginId = `login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		set({ login: { loginId, providerId: provider.id, providerName: provider.name } });
		// 每个流程只自动开一次浏览器（auth_url 可能重复发）
		let browserOpened = false;
		// 先订阅再 invoke：事件可能在 invoke 返回前到达
		const unsubscribe = getPi().onProviderLoginEvent((payload) => {
			if (payload.loginId !== loginId) return;
			const state = get().login;
			if (!state || state.loginId !== loginId) return;
			if (payload.kind === "prompt") {
				set({ login: { ...state, pendingPrompt: { promptId: payload.promptId, prompt: payload.prompt } } });
				return;
			}
			if (payload.kind === "prompt-cancel") {
				if (state.pendingPrompt?.promptId === payload.promptId) {
					set({ login: { ...state, pendingPrompt: undefined } });
				}
				return;
			}
			const event = payload.event;
			if (event.type === "auth_url") {
				set({ login: { ...state, authUrl: { url: event.url, instructions: event.instructions } } });
				if (!browserOpened) {
					browserOpened = true;
					void getPi().openExternal(event.url);
				}
			} else if (event.type === "device_code") {
				set({
					login: {
						...state,
						deviceCode: {
							userCode: event.userCode,
							verificationUri: event.verificationUri,
							expiresInSeconds: event.expiresInSeconds,
						},
					},
				});
			} else if (event.type === "progress") {
				set({ login: { ...state, statusLine: event.message } });
			} else if (event.type === "info") {
				set({ login: { ...state, statusLine: event.message, infoLinks: event.links } });
			}
		});
		try {
			const result = await getPi().startProviderLogin(loginId, provider.id);
			if (result.ok) {
				set({ login: null });
				// 凭证已持久化并同步运行时：刷新 provider 徽章 + 模型选择器
				await useSettingsStore.getState().refresh();
				await useSessionsStore.getState().loadModels();
			} else if (result.cancelled) {
				set({ login: null });
			} else {
				const state = get().login;
				if (state) {
					set({
						login: { ...state, pendingPrompt: undefined, error: result.error ?? "unknown error" },
					});
				}
			}
		} catch (error) {
			// invoke 层错误（并发守卫等）：保留对话框展示
			const state = get().login;
			if (state) {
				set({
					login: {
						...state,
						pendingPrompt: undefined,
						error: error instanceof Error ? error.message : String(error),
					},
				});
			}
		} finally {
			unsubscribe();
		}
	},

	/** 应答登录 prompt：await IPC 成功才清 pendingPrompt；失败恢复 prompt + 记 error（可重答） */
	respondLoginPrompt: async (value) => {
		const state = get().login;
		if (!state?.pendingPrompt) return;
		const { promptId } = state.pendingPrompt;
		try {
			await getPi().respondProviderLogin(state.loginId, promptId, value);
			// 函数式更新：await 期间 login 状态可能已推进（新 prompt/状态行），不可用旧快照整体覆盖
			set((s) => (s.login ? { login: { ...s.login, pendingPrompt: undefined } } : {}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			set((s) => (s.login ? { login: { ...s.login, error: message } } : {}));
		}
	},

	cancelProviderLogin: () => {
		const state = get().login;
		if (!state) return;
		void getPi().cancelProviderLogin(state.loginId);
	},

	dismissLogin: () => set({ login: null }),
}));
