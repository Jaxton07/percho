import type { UiPluginSettingValue } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";

type SettingsMap = Record<string, UiPluginSettingValue>;

/** 空值稳定引用（zustand selector 必须返回稳定引用，禁内联新对象） */
export const EMPTY_SETTINGS: SettingsMap = Object.freeze({}) as SettingsMap;

interface PluginSettingsState {
	/** 插件名 → 已读取的配置（键不存在 = 还没读过） */
	values: Record<string, SettingsMap>;
	/** 插件名 → 读取中（同一插件并发只发一次 IPC） */
	loading: Record<string, boolean>;
	/** 插件名 → 缓存代次：作废时 +1，`usePluginSettings` 据此重新读取（挂载中的组件也要能重读） */
	revisions: Record<string, number>;
	/** 插件名 → 本窗口尚未返回的写入数：用来忽略"自己写出来的回声事件" */
	writing: Record<string, number>;
	/** 读一次（已读过则复用缓存；force=true 强制重读） */
	load: (name: string, force?: boolean) => Promise<void>;
	/** patch 写入（undefined = 删除键）；乐观更新，落盘失败回滚 */
	update: (name: string, patch: Record<string, UiPluginSettingValue | undefined>) => Promise<void>;
	/** 作废缓存（配置事件到达时调用；name 省略 = 全部） */
	invalidate: (name?: string) => void;
}

/**
 * 插件自有配置的 renderer 缓存。
 *
 * 值的形状由 main 侧有界校验兜底（只可能是 JSON 标量），这里只负责缓存与乐观更新：
 * 插件在设置页里点开关时不应该等一个 IPC 往返，落盘失败再回滚并打日志。
 *
 * 两处容易出错的地方，都在这层处理掉：
 * 1. **回声事件**：本窗口写配置会让 main 广播一条 `settings` 事件。如果照单全收去回读，
 *    用户正在输入框里打字时会被旧值冲掉（写入还没落盘时的回读）。所以有在途写入就忽略这一条；
 * 2. **作废后没人重读**：`invalidate` 只删缓存的话，已经挂载的组件不会重新发请求，
 *    会一直显示默认值。因此额外维护 `revisions`，作废即自增，组件据此重读。
 */
export const usePluginSettingsStore = create<PluginSettingsState>((set, get) => ({
	values: {},
	loading: {},
	revisions: {},
	writing: {},

	load: async (name, force = false) => {
		const state = get();
		if (!force && state.values[name] !== undefined) return;
		if (state.loading[name]) return;
		set((s) => ({ loading: { ...s.loading, [name]: true } }));
		try {
			const values = await getPi().uiPluginsGetSettings({ name });
			set((s) => ({ values: { ...s.values, [name]: values } }));
		} catch (err) {
			console.error(`[ui-plugins] 读取 ${name} 的配置失败`, err);
			// 失败给空表：设置页显示默认值，而不是一直转圈
			set((s) => ({ values: { ...s.values, [name]: EMPTY_SETTINGS } }));
		} finally {
			set((s) => {
				const loading = { ...s.loading };
				delete loading[name];
				return { loading };
			});
		}
	},

	update: async (name, patch) => {
		const before = get().values[name] ?? EMPTY_SETTINGS;
		const next: SettingsMap = { ...before };
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete next[key];
			else next[key] = value;
		}
		set((s) => ({
			values: { ...s.values, [name]: next },
			writing: { ...s.writing, [name]: (s.writing[name] ?? 0) + 1 },
		}));
		try {
			await getPi().uiPluginsSetSettings({ name, patch });
		} catch (err) {
			console.error(`[ui-plugins] 写入 ${name} 的配置失败，已回滚`, err);
			set((s) => ({ values: { ...s.values, [name]: before } }));
		} finally {
			set((s) => {
				const writing = { ...s.writing };
				const left = (writing[name] ?? 1) - 1;
				if (left > 0) writing[name] = left;
				else delete writing[name];
				return { writing };
			});
		}
	},

	invalidate: (name) => {
		if (name === undefined) {
			set({ values: {}, loading: {}, revisions: {} });
			return;
		}
		// 本窗口还有没返回的写入：这条事件是自己写出来的，回读只会把用户刚打的字冲掉
		if ((get().writing[name] ?? 0) > 0) return;
		set((s) => {
			const values = { ...s.values };
			delete values[name];
			return { values, revisions: { ...s.revisions, [name]: (s.revisions[name] ?? 0) + 1 } };
		});
	},
}));
