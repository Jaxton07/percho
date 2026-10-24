import type { UiPluginAnchor } from "@percho/shared";
import type { ComponentType, ReactNode } from "react";
import { useUiPluginsStore } from "../stores/ui-plugins";
import { PluginBoundary } from "./PluginBoundary";
import { type Contribution, useUiPluginRegistry } from "./registry";
import { ShadowSurface } from "./ShadowSurface";
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
	// top-right 由宿主的「右上堆叠」定位（CornerStack：Todo 底边 + 8），这里只是独立渲染时的兜底位置
	[UI_REGIONS.CornerTopRight]: "top-2 right-4",
	[UI_REGIONS.CornerBottomLeft]: "bottom-2 left-4",
	[UI_REGIONS.CornerBottomRight]: "bottom-2 right-4",
};

/**
 * 区域挂载点：渲染某区域的全部贡献（一区域 N 个堆叠，顺序 = 启用先后）。
 * 容器语义（层级/pointer-events/anchor 对齐/堆叠方向）由本组件负责，插件只管渲染自己的内容：
 * - app.background：绝对填充 z-0，与自定义背景图同层同规则（界面默认不透明时不可见）；
 * - app.overlay：每贡献一个 fixed inset-0 z-20 pointer-events-none 容器 + anchor 对齐类；
 * - chat.corner.*：absolute z-20 flex-col 同角纵向堆叠（top-right 预留 pt-12 避开 TodoPanel）。
 *   `leading` 只对 `chat.corner.*` 有效：宿主自带的 UI 放在贡献之前，与贡献**共用同一个定位容器**
 *   （例：top-left 的「返回父会话」入口），这样永远不可能与合规贡献重叠；没有贡献时也能单独渲染。
 *   `layout="flow"` 表示**由父级提供定位**（例：top-right 由 `CornerStack` 统一堆叠：频道胶囊在上、贡献在下，
 *   一起避开 TodoPanel 的实际底边）—— 该区域自身不再绝对定位，也不再预留 pt-12。
 * 贡献崩溃 → PluginBoundary 兜底 null（没有默认可回退，spec §15）。
 */
export function RegionHost({
	region,
	leading,
	layout = "corner",
}: {
	region: RegionName;
	leading?: ReactNode;
	/** "corner"（默认）= 自己绝对定位到角上；"flow" = 由父级容器定位（宿主堆叠用） */
	layout?: "corner" | "flow";
}) {
	// 稳定引用纪律：contributions[region] 是 map 项（改动时整体换新数组），空用模块级 EMPTY
	const list = useUiPluginRegistry((s) => s.contributions[region]) ?? EMPTY_CONTRIBUTIONS;
	// 热重载换新边界实例（errored 归零），与 Slot 的 key 语义一致
	const nonces = useUiPluginRegistry((s) => s.loadNonces);
	// 全局总开关：关 = 全部贡献立即停用（与 Slot 同一开关语义；registry 保留，开回即恢复）
	const masterOn = useUiPluginsStore((s) => s.config.enabled);
	const hasContent = masterOn && list.length > 0;
	// leading 只在角区域有意义（那里有共用的绝对定位容器）；其他区域没有贡献就整体不渲染
	const isCorner = CORNER_POS_CLASSES[region] !== undefined;
	const showCornerContainer = (Boolean(leading) || layout === "flow") && isCorner;
	if (!hasContent && !showCornerContainer) return null;

	/**
	 * 贡献正文：isolation=shadow（perchoUi 2）→ 挂进 shadow root（宿主主题表 + 插件自带样式），
	 * 否则按 v1 行为直接渲染。区域容器语义（定位/层级）仍由外层 div 负责，不给插件。
	 */
	const renderBody = (c: Contribution) => {
		const Comp = c.component as ComponentType<Record<string, never>>;
		if (c.isolation === "shadow") {
			return (
				<ShadowSurface pluginName={c.pluginName} label={`region ${region}`} layout="form">
					<Comp />
				</ShadowSurface>
			);
		}
		return <Comp />;
	};

	const renderContribution = (c: Contribution) => (
		<div key={`${c.pluginName}:${c.id}:${nonces[c.pluginName] ?? 0}`} data-plugin={c.pluginName}>
			<PluginBoundary pluginName={c.pluginName} label={`region ${region}`}>
				{renderBody(c)}
			</PluginBoundary>
		</div>
	);

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
								{renderBody(c)}
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
					className={
						layout === "flow"
							? "pointer-events-none flex flex-col gap-2"
							: `pointer-events-none absolute z-20 flex flex-col gap-2 ${CORNER_POS_CLASSES[region]}`
					}
				>
					{leading}
					{hasContent && list.map(renderContribution)}
				</div>
			);
		case UI_REGIONS.ComposerFooter:
			// 输入框底部行内区域（ContextRing 旁）：横向排列，不抢 pointer-events（插件需交互自己开 auto）
			return <>{list.map(renderContribution)}</>;
		default:
			// settings.panel 不走 RegionHost（SettingsDialog 动态分类直接读 registry 渲染）
			return null;
	}
}
