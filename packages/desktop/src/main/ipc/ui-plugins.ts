import { IpcChannels, KNOWN_UI_SLOTS, type UiPluginsConfig } from "@percho/shared";
import { ipcMain, shell } from "electron";
import { loadUiPluginsConfig } from "../ui-plugins/config";
import type { UiPluginManager } from "../ui-plugins/manager";
import { sendToRenderer } from "./index";

/** 配置类变更（总开关/启用/指派）→ 通知 renderer 全量对齐 */
function pushConfigEvent(): void {
	sendToRenderer(IpcChannels.UiPluginsEvent, { kind: "config" });
}

/**
 * UI 插件域：配置读写 / 列表 / 构建 / 代码读取 / 目录打开。
 * 安全细则（spec §9）：readCode/openDir 只接受 manager 白名单内的合法插件名（禁路径）；
 * 所有参数做类型检查，非法直接 return。
 */
export function registerUiPluginsIpc(manager: UiPluginManager): void {
	ipcMain.handle(IpcChannels.UiPluginsGetConfig, () => loadUiPluginsConfig());

	ipcMain.handle(IpcChannels.UiPluginsSetEnabled, async (_e, enabled: boolean) => {
		if (typeof enabled !== "boolean") return;
		// await 落盘后才返回：renderer 的 invoke → loadAll 读到的是写入后的最新配置
		await manager.updateConfig({ enabled });
		pushConfigEvent();
	});

	ipcMain.handle(IpcChannels.UiPluginsList, () => manager.list());

	ipcMain.handle(IpcChannels.UiPluginsReadCode, (_e, name: string) => {
		if (typeof name !== "string" || name.length === 0) return { error: "参数非法" };
		return manager.readCode(name);
	});

	// 启用=信任：enabled=true 时 trusted 一并落盘
	ipcMain.handle(IpcChannels.UiPluginsSetPluginEnabled, async (_e, name: string, enabled: boolean) => {
		if (typeof name !== "string" || typeof enabled !== "boolean") return;
		const info = manager.info(name);
		if (!info || info.invalidReason) return;
		const config = await loadUiPluginsConfig();
		const prev = config.plugins[name];
		const patch: Partial<UiPluginsConfig> = {
			plugins: {
				...config.plugins,
				[name]: { enabled, trusted: enabled ? true : (prev?.trusted ?? false) },
			},
		};
		await manager.updateConfig(patch);
		pushConfigEvent();
	});

	ipcMain.handle(IpcChannels.UiPluginsAssignSlot, async (_e, slot: string, pluginName: string | null) => {
		if (typeof slot !== "string" || !KNOWN_UI_SLOTS.includes(slot)) return;
		if (pluginName !== null && typeof pluginName !== "string") return;
		const config = await loadUiPluginsConfig();
		const assignments = { ...config.assignments };
		if (pluginName === null) delete assignments[slot];
		else assignments[slot] = pluginName;
		await manager.updateConfig({ assignments });
		pushConfigEvent();
	});

	ipcMain.handle(IpcChannels.UiPluginsRebuild, async (_e, name: string) => {
		if (typeof name !== "string" || name.length === 0) return { ok: false as const, error: "参数非法" };
		const ok = await manager.ensureBuilt(name, true);
		if (!ok) {
			const info = manager.info(name);
			return { ok: false as const, error: info?.buildError ?? "构建失败" };
		}
		// 重建成功 → 通知 renderer 重载该插件（旧代码立即替换）
		sendToRenderer(IpcChannels.UiPluginsEvent, { kind: "changed", name });
		return { ok: true as const };
	});

	ipcMain.handle(IpcChannels.UiPluginsOpenDir, (_e, name: unknown) => {
		if (name !== undefined && name !== null && typeof name !== "string") return;
		const dir = typeof name === "string" ? manager.pluginDirOf(name) : manager.rootDir();
		if (!dir) return;
		void shell.openPath(dir);
	});
}
