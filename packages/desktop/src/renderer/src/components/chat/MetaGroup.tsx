import {
	dotsFromItems,
	type MetaDot,
	type MetaItem,
	summarizeCategories,
} from "@percho/shared";
import { Fragment, memo, useMemo } from "react";
import type { OrbState } from "thinking-orbs";
import { ThinkingOrb } from "thinking-orbs";
import { useT } from "../../i18n";
import { Slot } from "../../plugins/Slot";
import { UI_SLOTS } from "../../plugins/slots";
import { ExpandArrowIcon } from "../icons";
import { type LivePreviewItem, PreviewTicker } from "./PreviewTicker";
import { displayName, ToolCallCard } from "./ToolCallCard";
import { summaryLabel } from "./meta-summary-label";
import { useShownWorking } from "./use-shown-working";
import { useSweepHighlight } from "./use-sweep-highlight";

export type { MetaItem };

/** 思考过程行（内层折叠，与 tool call 行同风格） */
function ThinkingRow({ thinking }: { thinking: string }) {
	const t = useT();
	return (
		<details className="group/dets drawer-details">
			<summary className="group/row flex cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-[13px] font-semibold text-ink-faint transition-colors group-hover/row:text-ink">
					{t("message.thinking")}
				</span>
				<ExpandArrowIcon className="shrink-0 text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2 group-open/dets:rotate-90" />
			</summary>
			<div className="py-1 pl-4 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink-dim select-text">
				{thinking}
			</div>
		</details>
	);
}
/** 圆点样式：done = 实心 ink-dim（与 worked 态标题同色，弱化存在感），error = 琥珀 warn token，running = 空心呼吸（globals.css meta-dot-running）；4px 小点紧密成串 */
function dotClass(state: MetaDot["state"]): string {
	const base = "h-1 w-1 shrink-0 rounded-full";
	if (state === "running") return `${base} meta-dot-running`;
	return state === "error" ? `${base} bg-warn` : `${base} bg-ink-dim`;
}

/**
 * 外层折叠组：聚合多条非正文消息的思考/工具。
 * 标题行：working 期 = Working/Thinking 标签 + 内联预览行；worked 期 = 分类统计单行
 * （读取/编辑/探索/搜索/执行命令，未知工具按原名计数；无工具时回退 Worked 标签）。
 * 其下圆点行按 tool call 逐粒追加（done 实心 ink / error 灰 / running 空心呼吸），working 期
 * 实时、结束后随 items 冻结，展开组时隐藏。展开区为完整思考行/工具卡。
 * endImmediately：组被正文边界切分（streaming.text 在输出）或 run 已终结 → working 信号消失时
 * 立即结束，不做滞后缓冲；否则（turn/工具间隙）滞后 HYSTERESIS_MS 防闪烁
 */
/**
 * memo 比较器：items 元素逐一身份比较（历史 MetaItem 由 chat-rows 的 WeakMap 缓存保证引用稳定；
 * 数组本身每次重建，不能比数组身份）。working/endImmediately/subagentCount 为原始值。
 * 语言切换不受影响：useT/i18n 订阅在组件内部，父级 memo 拦不住也不需要拦。
 */
function metaGroupPropsEqual(
	a: { items: MetaItem[]; working: boolean; endImmediately?: boolean; subagentCount?: number },
	b: { items: MetaItem[]; working: boolean; endImmediately?: boolean; subagentCount?: number },
): boolean {
	if (
		a.working !== b.working ||
		a.endImmediately !== b.endImmediately ||
		a.subagentCount !== b.subagentCount ||
		a.items.length !== b.items.length
	)
		return false;
	for (let i = 0; i < a.items.length; i++) {
		if (a.items[i] !== b.items[i]) return false;
	}
	return true;
}

export const MetaGroup = memo(function MetaGroup({
	items,
	working,
	endImmediately = false,
	subagentCount = 0,
}: {
	items: MetaItem[];
	working: boolean;
	endImmediately?: boolean;
	/** 该组派生的子代理数（统计行正向显示「子代理 ×N」；由 MessageList 按组归属计算） */
	subagentCount?: number;
}) {
	const t = useT();
	const count = items.reduce((n, item) => n + (item.thinking ? 1 : 0) + item.tools.length, 0);
	// 圆点序列：组内工具按到达顺序展开（working 期实时追加；组结束后随 items 冻结在原位）
	const dots = useMemo(() => dotsFromItems(items), [items]);
	// 分类汇总：worked 态标题行（working 期不显示；展开组时标题仍在）
	const segments = useMemo(() => summarizeCategories(items, subagentCount), [items, subagentCount]);

	// 滞后缓冲：working 信号消失后需保持缓冲才显示 worked（turn 间隙内不闪烁）；
	// 与 CenterOrb 中央动画共用同一 hook，两处显隐节奏一致
	const shownWorking = useShownWorking(working, endImmediately);
	// 状态行小 orb 恒显示：中央动画开关（centerOrbEnabled）与本行解耦，互不让位

	const rows = items.flatMap((item, i) => [
		// biome-ignore lint/suspicious/noArrayIndexKey: 折叠组内项无独立 id，列表顺序稳定
		item.thinking ? <ThinkingRow key={`thinking-${i}`} thinking={item.thinking} /> : null,
		...item.tools.map((tool) => (
			<Slot key={tool.key} name={UI_SLOTS.ToolCallCard} props={{ tool }} fallback={ToolCallCard} />
		)),
	]);
	// orb 状态（名字是包的渲染器名，与我们的语义不同名）：
	// tool 运行中 → connecting（星座连线 + 信号跑边）
	// 纯 thinking → working（粒子轨道，转速更快）
	// （必须在 liveItems 之前推导，因为 liveItems 会过滤掉 thinking）
	const latestActivity = useMemo(() => {
		for (let i = items.length - 1; i >= 0; i--) {
			const activity = items[i]?.activity;
			if (activity && activity.length > 0) {
				return activity[activity.length - 1];
			}
		}
		return undefined;
	}, [items]);
	const isTool = latestActivity?.kind === "tool";
	const orbState: OrbState = isTool ? "connecting" : "working";
	const labelKey = isTool ? "message.working" : "message.thinkingLabel";

	// 实时预览：完整活动序列按到达顺序展开，ticker 在 thinking/tool 间保持 latest-wins。
	// 内容已由 reducer 分块累计；这里不重新合并、解析或摘要。
	const liveItems = useMemo<LivePreviewItem[]>(() => {
		const out: LivePreviewItem[] = [];
		for (const item of items) {
			if (!item.activity) continue;
			for (const entry of item.activity) {
				if (entry.kind === "thinking") {
					out.push({ kind: "thinking", id: entry.id, text: entry.text });
				} else {
					out.push({ kind: "tool", id: entry.id, name: entry.name, text: entry.args });
				}
			}
		}
		return out;
	}, [items]);

	// 扫光目标集合（预览行 id）标识：集合变化 → hook 内同帧补样式，消除新行首帧实色闪烁
	const liveKey = liveItems.map((i) => i.id).join(",");
	const { labelRef, wrapRef: tickerWrapRef } = useSweepHighlight(shownWorking, liveKey);


	/** 单条已结束（如正文前的思考）直接裸行展示，不套 "已完成 · 1" 外壳；-mb-4 与包装组一致：
	 * 与后续正文净距 8px（容器 gap-6 - 16px），单行/成组间距统一 */
	// 纯子代理调用不带普通 tool/thinking，仍须保留折叠状态行作为卡片的时间锚点。
	const showWrapper = count >= 2 || shownWorking || subagentCount > 0;
	if (!showWrapper) {
		return <div className="-mb-4 flex flex-col gap-1.5">{rows}</div>;
	}

	return (
		// -mb-4：抵消容器 gap-6 的一部分，折叠行与后续正文净距 8px（成组与单行一致）
		<div className="-mb-4">
			<details className="group/outer peer drawer-details">
				<summary className="group/row flex cursor-pointer select-none flex-col [&::-webkit-details-marker]:hidden">
					{/* min-h-6：与内联预览行（h-6）等高，working/worked 切换首行行高不变 */}
					<div className="flex min-h-6 w-full items-center gap-2 py-0.5">
						{shownWorking ? (
							<>
								<div className="flex shrink-0 items-center gap-2">
									<ThinkingOrb state={orbState} size={20} paused={false} />
									<span
										ref={labelRef}
										className="sweep-target text-[14px] font-bold text-ink-working transition-colors group-hover/row:text-ink"
									>
										{t(labelKey)}
									</span>
								</div>
								{/* 实时预览内联进标题行（单行截断，展开组时隐藏） */}
								<div ref={tickerWrapRef} className="min-w-0 flex-1 group-open/outer:hidden">
									<PreviewTicker items={liveItems} reserveSpace />
								</div>
							</>
						) : segments.length > 0 ? (
							/* worked 态标题 = 分类统计（原展开区速读行提上来）；单行截断，hover 变色提示可展开 */
							<span className="min-w-0 flex-1 truncate text-[13px] text-ink-dim transition-colors group-hover/row:text-ink">
								{segments.map((seg, i) => (
									<Fragment key={seg.key}>
										{i > 0 && <span className="opacity-50"> · </span>}
										{summaryLabel(t, seg)}
									</Fragment>
								))}
							</span>
						) : (
							<span
								ref={labelRef}
								className="text-[14px] font-bold text-ink-dim transition-colors group-hover/row:text-ink"
							>
								{t("message.worked")}
							</span>
						)}
					</div>
					{/* 圆点行：一次 tool call 一粒（running 空心呼吸 → done 实心 ink-dim / error ink-faint），working 期实时追加、
					    结束后随 items 冻结原位；超长 flex-wrap 换行；展开组时隐藏（展开区有完整工具卡）。
					    左缘与状态行（orb/标签）对齐；gap-1 紧密成串（密度感） */}
					{dots.length > 0 && (
						<div className="mb-0.5 flex flex-wrap gap-1 py-0.5 group-open/outer:hidden">
							{dots.map((dot) => (
								<span key={dot.key} className={dotClass(dot.state)} />
							))}
						</div>
					)}
				</summary>
				<div className="flex flex-col gap-1.5 py-1">{rows}</div>
			</details>
		</div>
	);
}, metaGroupPropsEqual);
