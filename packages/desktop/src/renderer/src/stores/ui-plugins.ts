import type { UiPluginInfo, UiPluginsConfig } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";

/** 空插件列表稳定引用（selector 缺省用，禁内联新数组） */
export const EMPTY_PLUGINS: UiPluginInfo[] = [];

interface UiPluginsStore {
	config: UiPluginsConfig;
	plugins: UiPluginInfo[];
	/** 插件名 → 最近一次代码加载失败（import 语法错等；设置面板展示） */
	loadErrors: Record<string, string>;
	/** 全量拉取 config + 插件列表（面板与 loader 共用；事件驱动与手动刷新都走它） */
	loadAll: () => Promise<void>;
	/** 全局总开关（关 = 全部插件立即停用，Slot 走 masterEnabled 判断，无需逐插件操作） */
	setMaster: (enabled: boolean) => Promise<void>;
	/** 启用/停用单个插件（启用=信任，main 同步落盘） */
	setPluginEnabled: (name: string, enabled: boolean) => Promise<void>;
	/** 槽位指派（pluginName=null 取消指派） */
	assignSlot: (slot: string, pluginName: string | null) => Promise<void>;
	/** 重新构建插件（结果经 list 刷新体现） */
	rebuild: (name: string) => Promise<void>;
	/** 打开插件目录（不传 name 开根目录） */
	openDir: (name?: string) => Promise<void>;
	setLoadError: (name: string, error?: string) => void;
}

export const useUiPluginsStore = create<UiPluginsStore>((set, get) => ({
	config: { enabled: false, plugins: {}, assignments: {} },
	plugins: EMPTY_PLUGINS,
	loadErrors: {},
	loadAll: async () => {
		try {
			const [config, plugins] = await Promise.all([getPi().uiPluginsGetConfig(), getPi().uiPluginsList()]);
			set({ config, plugins });
		} catch (err) {
			console.error("[ui-plugins] loadAll failed", err);
		}
	},
	setMaster: async (enabled) => {
		await getPi().uiPluginsSetEnabled(enabled);
		await get().loadAll();
	},
	setPluginEnabled: async (name, enabled) => {
		await getPi().uiPluginsSetPluginEnabled(name, enabled);
		await get().loadAll();
	},
	assignSlot: async (slot, pluginName) => {
		await getPi().uiPluginsAssignSlot(slot, pluginName);
		await get().loadAll();
	},
	rebuild: async (name) => {
		await getPi().uiPluginsRebuild(name);
		await get().loadAll();
	},
	openDir: async (name) => {
		await getPi().uiPluginsOpenDir(name);
	},
	setLoadError: (name, error) => {
		set((state) => {
			const loadErrors = { ...state.loadErrors };
			if (error === undefined) delete loadErrors[name];
			else loadErrors[name] = error;
			return { loadErrors };
		});
	},
}));
