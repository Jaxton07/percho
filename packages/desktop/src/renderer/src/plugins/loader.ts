import {
	KNOWN_UI_SLOTS,
	type UiPluginInfo,
	type UiPluginManifest,
	type UiPluginsConfig,
} from "@percho/shared";
import { getPi } from "../api";
import { useUiPluginsStore } from "../stores/ui-plugins";
import { useUiPluginRegistry } from "./registry";
import type { SlotName } from "./slots";

/**
 * 计算一个插件实际指派的槽位（spec §7.3：manifest.slots + config.assignments 过滤）：
 * - 槽位有指派（assignments[slot]）：只有指派给本插件才生效；
 * - 无指派且只有一个启用插件声明该槽位：自动指派；
 * - 多个启用插件争抢且未指派：都不生效（用户去设置面板选）。
 */
function computeAssignedSlots(
	manifest: UiPluginManifest,
	allPlugins: UiPluginInfo[],
	config: UiPluginsConfig,
): SlotName[] {
	const out: SlotName[] = [];
	for (const slot of Object.keys(manifest.slots ?? {}) as SlotName[]) {
		if (!KNOWN_UI_SLOTS.includes(slot)) continue;
		const contenders = allPlugins.filter(
			(p) => p.enabled && !p.invalidReason && !p.buildError && p.slots[slot] !== undefined,
		);
		const assigned = config.assignments[slot];
		if (assigned === manifest.name) {
			out.push(slot);
		} else if (assigned === undefined && contenders.length === 1 && contenders[0]?.name === manifest.name) {
			out.push(slot);
		}
	}
	return out;
}

/** 把插件代码（esbuild 产物）经 Blob URL 动态 import 后注册进 registry */
async function loadPluginCode(
	manifest: UiPluginManifest,
	code: string,
	assignedSlots: SlotName[],
): Promise<void> {
	const blob = new Blob([code], { type: "text/javascript" });
	const url = URL.createObjectURL(blob);
	try {
		const module = await import(/* @vite-ignore */ url);
		// 热重载语义：先卸旧版（removePlugin 清 override + 崩溃计数）再注册新版
		useUiPluginRegistry.getState().removePlugin(manifest.name);
		const res = useUiPluginRegistry
			.getState()
			.applyPlugin(manifest, module as Record<string, unknown>, assignedSlots);
		if (!res.ok) {
			console.warn(`[ui-plugins] ${manifest.name} 部分槽位导出缺失:`, res.missing);
		}
		useUiPluginsStore.getState().setLoadError(manifest.name);
	} catch (err) {
		console.error(`[ui-plugins] ${manifest.name} 代码加载失败`, err);
		useUiPluginsStore.getState().setLoadError(manifest.name, String(err));
	} finally {
		// module 已加载，Blob URL 可回收
		URL.revokeObjectURL(url);
	}
}

/** 卸载全部 override 后重新加载所有启用插件（config 事件的全量对齐，简单粗暴不错序） */
async function reloadAll(): Promise<void> {
	const store = useUiPluginsStore.getState();
	await store.loadAll();
	const { config, plugins } = useUiPluginsStore.getState();
	// 收集全部已注册插件名（槽位 override + 区域贡献，纯贡献插件也要先卸再重载）
	const registeredNames = new Set<string>();
	const registered = useUiPluginRegistry.getState().overrides;
	for (const slot of Object.keys(registered) as SlotName[]) {
		const name = registered[slot]?.pluginName;
		if (name) registeredNames.add(name);
	}
	const registeredContributions = useUiPluginRegistry.getState().contributions;
	for (const region of Object.keys(registeredContributions)) {
		for (const c of registeredContributions[region] ?? []) registeredNames.add(c.pluginName);
	}
	for (const name of registeredNames) useUiPluginRegistry.getState().removePlugin(name);
	for (const p of plugins) {
		if (!p.enabled || !p.trusted || p.invalidReason || p.buildError) continue;
		const res = await getPi().uiPluginsReadCode(p.name);
		if ("error" in res) {
			console.warn(`[ui-plugins] ${p.name} 读代码失败:`, res.error);
			store.setLoadError(p.name, res.error);
			continue;
		}
		await loadPluginCode(res.manifest, res.code, computeAssignedSlots(res.manifest, plugins, config));
	}
}

/** 重载单个插件（changed 事件；Phase 2 fs.watch 热重载的来源）。先刷新列表再判断，防陈旧状态 */
async function reloadPlugin(name: string): Promise<void> {
	await useUiPluginsStore.getState().loadAll();
	const { config, plugins } = useUiPluginsStore.getState();
	const p = plugins.find((x) => x.name === name);
	if (!p?.enabled || !p.trusted || p.invalidReason || p.buildError) return;
	const res = await getPi().uiPluginsReadCode(name);
	if ("error" in res) {
		console.warn(`[ui-plugins] ${name} 读代码失败:`, res.error);
		useUiPluginsStore.getState().setLoadError(name, res.error);
		return;
	}
	await loadPluginCode(res.manifest, res.code, computeAssignedSlots(res.manifest, plugins, config));
}

let subscribed = false;

/**
 * 重载操作串行化：config/changed 事件可能并发到达，reloadAll 与 reloadPlugin 交错执行
 * remove/apply 会瞬态丢贡献/override（Phase 3 dogfood 实测）。模块级 promise 链保证
 * 任何时刻只有一个重载操作在途。
 */
let reloadChain: Promise<void> = Promise.resolve();
function enqueueReload(fn: () => Promise<void>): void {
	reloadChain = reloadChain.then(fn, fn);
}

/**
 * 初始化 UI 插件加载链路（App 挂载时调用一次）：
 * 先拉真实配置（store 初始态不是磁盘配置），总开关关 → 只订阅事件；否则加载全部启用+信任+构建成功的插件。
 */
export async function initUiPlugins(): Promise<void> {
	if (!subscribed) {
		subscribed = true;
		getPi().onUiPluginsEvent((payload) => {
			if (payload.kind === "config") enqueueReload(() => reloadAll());
			else if (payload.kind === "changed") enqueueReload(() => reloadPlugin(payload.name));
		});
	}
	await useUiPluginsStore.getState().loadAll();
	const { config } = useUiPluginsStore.getState();
	if (!config.enabled) return;
	await reloadAll();
}
