import { IpcChannels, KNOWN_UI_SLOTS, UI_PLUGINS_CHANNELS } from "@percho/shared";
import { shell } from "electron";
import { loadUiPluginsConfig } from "../ui-plugins/config";
import type { UiPluginManager } from "../ui-plugins/manager";
import { isValidPluginStateKey, readPluginState, writePluginState } from "../ui-plugins/plugin-state";
import type { UiWorkbenchTrust } from "../ui-plugins/workbench-trust";
import { registerInvokeHandlers } from "./invoke";
import { sendToRenderer } from "./send";

/** 配置类变更（总开关/启用/指派）→ 通知 renderer 全量对齐 */
function pushConfigEvent(): void {
	sendToRenderer(IpcChannels.UiPluginsEvent, { kind: "config" });
}

/**
 * UI 插件域：配置读写 / 列表 / 构建 / 代码读取 / 目录打开。
 * 安全细则（spec §9）：readCode/openDir 只接受 manager 白名单内的合法插件名（禁路径）；
 * 所有参数做类型检查，非法直接 return。
 */
export function registerUiPluginsIpc(
	manager: UiPluginManager,
	trust: Pick<UiWorkbenchTrust, "configurePlugin" | "serve">,
): void {
	registerInvokeHandlers(UI_PLUGINS_CHANNELS, {
		uiPluginsGetConfig: () => loadUiPluginsConfig(),
		// 启用=信任：enabled=true 时 trusted 一并落盘；await 落盘后才返回（renderer invoke 读到的是写入后的最新配置）
		uiPluginsSetEnabled: async ({ enabled }) => {
			if (typeof enabled !== "boolean") return;
			await manager.updateConfig({ kind: "set-enabled", enabled });
			pushConfigEvent();
		},
		uiPluginsList: () => manager.list(),
		// readCode/openDir 只接受 manager 白名单内的合法插件名（禁路径，spec §9）
		uiPluginsReadCode: async ({ name }) => {
			if (typeof name !== "string" || name.length === 0) return { error: "参数非法" };
			try {
				return await trust.serve(name, () => manager.readCode(name));
			} catch (error) {
				return { error: error instanceof Error ? error.message : "Plugin trust check failed" };
			}
		},
		uiPluginsSetPluginEnabled: async ({ name, enabled }) => {
			if (typeof name !== "string" || typeof enabled !== "boolean") return;
			const info = manager.info(name);
			if (!info || info.invalidReason) return;
			const changed = await trust.configurePlugin(name, enabled, () =>
				manager.updateConfig({ kind: "set-plugin-enabled", name, enabled }),
			);
			if (!changed) return;
			pushConfigEvent();
		},
		uiPluginsAssignSlot: async ({ slot, pluginName }) => {
			if (typeof slot !== "string" || !KNOWN_UI_SLOTS.includes(slot)) return;
			if (pluginName !== null && typeof pluginName !== "string") return;
			await manager.updateConfig({ kind: "assign-slot", slot, pluginName });
			pushConfigEvent();
		},
		uiPluginsRebuild: async ({ name }) => {
			if (typeof name !== "string" || name.length === 0) return { ok: false as const, error: "参数非法" };
			const ok = await manager.ensureBuilt(name, true);
			if (!ok) {
				const info = manager.info(name);
				return { ok: false as const, error: info?.buildError ?? "构建失败" };
			}
			// 重建成功 → 通知 renderer 重载该插件（旧代码立即替换）
			sendToRenderer(IpcChannels.UiPluginsEvent, { kind: "changed", name });
			return { ok: true as const };
		},
		uiPluginsOpenDir: ({ name }) => {
			if (name !== undefined && name !== null && typeof name !== "string") return;
			const dir = typeof name === "string" ? manager.pluginDirOf(name) : manager.rootDir();
			if (!dir) return;
			void shell.openPath(dir);
		},
		// 插件状态只给已扫描、已启用且受信任的插件；宿主按它自己的名字调用，插件代码拿不到这个 IPC
		uiPluginsReadState: async ({ name }) => {
			if (typeof name !== "string" || !canUseState(manager, name)) return {};
			return readPluginState(name);
		},
		uiPluginsWriteState: async ({ name, key, value }) => {
			if (typeof name !== "string" || !canUseState(manager, name))
				return { ok: false as const, error: "Plugin is not enabled" };
			if (!isValidPluginStateKey(key)) return { ok: false as const, error: "Invalid state key" };
			try {
				await writePluginState(name, key, value);
				return { ok: true as const };
			} catch (error) {
				return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
			}
		},
	});
}

function canUseState(manager: UiPluginManager, name: string): boolean {
	const info = manager.info(name);
	return Boolean(info?.enabled && info.trusted && !info.invalidReason);
}
