import type { UiPluginAnchor } from "@percho/shared";
import type { ComponentType } from "react";
import { PluginBoundary } from "./PluginBoundary";
import { type Contribution, useUiPluginRegistry } from "./registry";
import { type RegionName, UI_REGIONS } from "./slots";

/** 区域空列表稳定引用（selector 缺省用，禁内联新数组） */
export const EMPTY_CONTRIBUTIONS: Contribution[] = [];

/** app.overlay 九宫格锚点 → 容器对齐类（spec §15：每贡献一个 fixed inset-0 z-20 pointer-events-none 容器） */
const OVERLAY_ANCHOR_CLASSES: Record<UiPluginAnchor, string> = {
	"top-left": "items-start justify-start",
	"top-center": "items-start justify-center",
	"top-right": "items-start justify-end",
	"center-left": "items-center justify-start",
	center: "items-center justify-center",
	"center-right": "items-center justify-end",
	"bottom-left": "items-end justify-start",
	"bottom-center": "items-end justify-center",
	"bottom-right": "items-end justify-end",
};

/** 聊天区四角定位（与 TodoPanel 同语义不重叠；top-right 与 TodoPanel 同角，预留 pt-12 堆在其下） */
const CORNER_POS_CLASSES: Partial<Record<RegionName, string>> = {
	[UI_REGIONS.CornerTopLeft]: "top-2 left-4",
	[UI_REGIONS.CornerTopRight]: "top-2 right-4 pt-12",
	[UI_REGIONS.CornerBottomLeft]: "bottom-2 left-4",
	[UI_REGIONS.CornerBottomRight]: "bottom-2 right-4",
};

/**
 * 区域挂载点：渲染某区域的全部贡献（一区域 N 个堆叠，顺序 = 启用先后）。
 * 容器语义（层级/pointer-events/anchor 对齐/堆叠方向）由本组件负责，插件只管渲染自己的内容：
 * - app.background：绝对填充 z-0，与自定义背景图同层同规则（界面默认不透明时不可见）；
 * - app.overlay：每贡献一个 fixed inset-0 z-20 pointer-events-none 容器 + anchor 对齐类；
 * - chat.corner.*：absolute z-20 flex-col 同角纵向堆叠（top-right 预留 pt-12 避开 TodoPanel）。
 * 贡献崩溃 → PluginBoundary 兜底 null（没有默认可回退，spec §15）。
 */
export function RegionHost({ region }: { region: RegionName }) {
	// 稳定引用纪律：contributions[region] 是 map 项（改动时整体换新数组），空用模块级 EMPTY
	const list = useUiPluginRegistry((s) => s.contributions[region]) ?? EMPTY_CONTRIBUTIONS;
	// 热重载换新边界实例（errored 归零），与 Slot 的 key 语义一致
	const nonces = useUiPluginRegistry((s) => s.loadNonces);
	if (list.length === 0) return null;

	const renderContribution = (c: Contribution) => {
		const Comp = c.component as ComponentType<Record<string, never>>;
		return (
			<div key={`${c.pluginName}:${c.id}:${nonces[c.pluginName] ?? 0}`} data-plugin={c.pluginName}>
				<PluginBoundary pluginName={c.pluginName} label={`region ${region}`}>
					<Comp />
				</PluginBoundary>
			</div>
		);
	};

	switch (region) {
		case UI_REGIONS.AppBackground:
			return (
				<div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
					{list.map(renderContribution)}
				</div>
			);
		case UI_REGIONS.AppOverlay:
			return (
				<>
					{list.map((c) => (
						<div
							key={`${c.pluginName}:${c.id}:${nonces[c.pluginName] ?? 0}`}
							data-plugin={c.pluginName}
							className={`pointer-events-none fixed inset-0 z-20 flex ${OVERLAY_ANCHOR_CLASSES[c.anchor ?? "bottom-right"]}`}
						>
							<PluginBoundary pluginName={c.pluginName} label={`region ${region}`}>
								<c.component />
							</PluginBoundary>
						</div>
					))}
				</>
			);
		case UI_REGIONS.CornerTopLeft:
		case UI_REGIONS.CornerTopRight:
		case UI_REGIONS.CornerBottomLeft:
		case UI_REGIONS.CornerBottomRight:
			return (
				<div
					className={`pointer-events-none absolute z-20 flex flex-col gap-2 ${CORNER_POS_CLASSES[region]}`}
				>
					{list.map(renderContribution)}
				</div>
			);
		default:
			// settings.panel 不走 RegionHost（SettingsDialog 动态分类直接读 registry 渲染）
			return null;
	}
}
