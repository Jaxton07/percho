import type { UiPluginAnchor, UiPluginManifest } from "@percho/shared";
import type { ComponentType } from "react";
import { create } from "zustand";
import type { SlotName } from "./slots";

/** 连续崩溃自动禁用阈值（reportCrash 达到该次数返回 true） */
export const CRASH_THRESHOLD = 3;

/**
 * React.memo/forwardRef/lazy 包装后的组件导出是对象（$$typeof 标记）而非函数。
 * spec §13 要求插件用 React.memo，§7.3 说导出必须是函数——取并集：两者都接受。
 */
const REACT_WRAPPED_TYPES = new Set([
	Symbol.for("react.memo"),
	Symbol.for("react.forward_ref"),
	Symbol.for("react.lazy"),
]);

function isComponent(exported: unknown): boolean {
	if (typeof exported === "function") return true;
	return (
		typeof exported === "object" &&
		exported !== null &&
		REACT_WRAPPED_TYPES.has((exported as { $$typeof?: symbol }).$$typeof as symbol)
	);
}

/** 一个槽位的激活 override（一个槽位同时最多一个） */
export interface SlotOverride {
	pluginName: string;
	/** manifest.slots 里的具名导出名 */
	exportName: string;
	/** 实际为对应槽位 props 的组件；注册处做存在性检查 */
	component: ComponentType<never>;
}

/** 一条已注册的区域贡献（一区域 N 个堆叠，顺序 = 注册顺序即启用先后） */
export interface Contribution {
	pluginName: string;
	/** manifest.contributions[].id（插件内唯一） */
	id: string;
	/** manifest.contributions[].export（bundle 具名导出名） */
	exportName: string;
	/** 贡献组件无 props（store 连接型），注册处做存在性检查 */
	component: ComponentType<Record<string, never>>;
	/** 仅 app.overlay 有意义（RegionHost 转容器对齐类） */
	anchor?: UiPluginAnchor;
	/** 展示名（settings.panel 用作设置分类标题） */
	title?: string;
}

interface UiPluginRegistryState {
	/** 槽位 → 激活的 override */
	overrides: Partial<Record<SlotName, SlotOverride>>;
	/** 区域 → 贡献列表（一区域 N 个堆叠；列表为稳定引用，改动时整体换新数组） */
	contributions: Record<string, Contribution[]>;
	/** 插件名 → 连续崩溃次数（≥3 自动禁用） */
	crashCounts: Record<string, number>;
	/**
	 * 插件名 → 加载代数（applyPlugin 对该插件 +1，removePlugin 清除）。
	 * Slot/RegionHost 用它做错误边界的 key：热重载（remove+apply 被 React 批处理）时换新边界实例，errored 归零。
	 */
	loadNonces: Record<string, number>;
	/**
	 * 注册一个插件的全部槽位 override（按 manifest.slots + config.assignments 过滤后的
	 * assignedSlots）与全部区域贡献（manifest.contributions，一区域 N 个堆叠）。
	 * exportName 在 module 里不存在或不是组件 → 记入 missing 且不注册该项。
	 */
	applyPlugin(
		manifest: UiPluginManifest,
		module: Record<string, unknown>,
		assignedSlots: SlotName[],
	): { ok: boolean; missing: string[] };
	/** 移除一个插件的全部 override 与贡献（禁用/卸载/热重载前调用），崩溃计数一并清零 */
	removePlugin(pluginName: string): void;
	/** ErrorBoundary 上报崩溃；返回是否达到自动禁用阈值 */
	reportCrash(pluginName: string): boolean;
}

export const useUiPluginRegistry = create<UiPluginRegistryState>((set, get) => ({
	overrides: {},
	contributions: {},
	crashCounts: {},
	loadNonces: {},
	applyPlugin: (manifest, module, assignedSlots) => {
		const missing: string[] = [];
		// 浅拷贝后写新 override：未触碰的槽位保持原对象引用（selector 稳定引用纪律）
		const overrides = { ...get().overrides };
		for (const slot of assignedSlots) {
			const exportName = manifest.slots?.[slot];
			if (!exportName) continue; // 插件未声明该槽位：跳过（正常由调用方按 assignedSlots 过滤）
			const exported = module[exportName];
			if (!isComponent(exported)) {
				missing.push(`${slot} → ${exportName}`);
				continue;
			}
			overrides[slot] = {
				pluginName: manifest.name,
				exportName,
				component: exported as ComponentType<never>,
			};
		}
		// 区域贡献：一区域 N 个堆叠，追加到该区域列表尾部（新数组整体换入，稳定引用纪律）
		const contributions = { ...get().contributions };
		for (const c of manifest.contributions ?? []) {
			const exported = module[c.export];
			if (!isComponent(exported)) {
				missing.push(`${c.region}#${c.id} → ${c.export}`);
				continue;
			}
			const list = contributions[c.region] ?? [];
			contributions[c.region] = [
				...list,
				{
					pluginName: manifest.name,
					id: c.id,
					exportName: c.export,
					component: exported as ComponentType<Record<string, never>>,
					anchor: c.anchor,
					title: c.title,
				},
			];
		}
		const loadNonces = {
			...get().loadNonces,
			[manifest.name]: (get().loadNonces[manifest.name] ?? 0) + 1,
		};
		set({ overrides, contributions, loadNonces });
		return { ok: missing.length === 0, missing };
	},
	removePlugin: (pluginName) => {
		const overrides = { ...get().overrides };
		for (const slot of Object.keys(overrides) as SlotName[]) {
			if (overrides[slot]?.pluginName === pluginName) delete overrides[slot];
		}
		const contributions = { ...get().contributions };
		for (const region of Object.keys(contributions)) {
			const list = contributions[region];
			if (!list) continue;
			const filtered = list.filter((c) => c.pluginName !== pluginName);
			if (filtered.length === 0) delete contributions[region];
			else contributions[region] = filtered;
		}
		const crashCounts = { ...get().crashCounts };
		delete crashCounts[pluginName];
		// 注意：loadNonces **不清除**——热重载序列 remove+apply 后若 nonce 从 0 重新计，
		// Slot/RegionHost 的边界 key（pluginName:nonce）不变，崩溃边界实例永不重建（review 修项 B 的漏洞，
		// Phase 3 崩溃隔离测试暴露）。nonce 单调递增保证每次热重载 key 必变、errored 归零。
		set({ overrides, contributions, crashCounts });
	},
	reportCrash: (pluginName) => {
		const count = (get().crashCounts[pluginName] ?? 0) + 1;
		set({ crashCounts: { ...get().crashCounts, [pluginName]: count } });
		return count >= CRASH_THRESHOLD;
	},
}));
