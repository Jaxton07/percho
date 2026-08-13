import { useEffect, useMemo, useRef, useState } from "react";
import type { OrbState } from "thinking-orbs";
import { ThinkingOrb } from "thinking-orbs";
import { useT } from "../../i18n";
import type { ActivityEntry, UIToolCall } from "../../stores/transcript";
import { ExpandArrowIcon } from "../icons";
import { type LivePreviewItem, PreviewTicker } from "./PreviewTicker";
import { ToolCallCard } from "./ToolCallCard";

/** 折叠组中的一条元数据项（一条消息的思考/工具，或流式中的进行中部分） */
export interface MetaItem {
	thinking: string;
	tools: UIToolCall[];
	/** 流式项的活动序列（到达顺序），预览行数据源；仅流式（未提交）项携带 */
	activity?: ActivityEntry[];
}

/** 思考过程行（内层折叠，与 tool call 行同风格） */
function ThinkingRow({ thinking }: { thinking: string }) {
	const t = useT();
	return (
		<details className="group/dets">
			<summary className="group/row flex cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-[13px] font-semibold text-ink-faint transition-colors group-hover/row:text-ink">
					{t("message.thinking")}
				</span>
				<ExpandArrowIcon className="shrink-0 text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2 group-open/dets:rotate-90" />
			</summary>
			<div className="py-1 pl-4 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-dim select-text">
				{thinking}
			</div>
		</details>
	);
}
/** working → worked 切换的缓冲时长：turn 间隙内不闪烁 */
const HYSTERESIS_MS = 1500;
/** 统一扫光周期（与 globals.css 的 shimmer-sweep 1.6s 一致） */
const SWEEP_MS = 1600;
const SWEEP_GRADIENT =
	"linear-gradient(90deg, currentColor 40%, var(--shimmer-highlight) 50%, currentColor 60%)";

/** 清除 rAF 扫光写在元素上的内联背景/填充样式（恢复常规文字颜色） */
function clearSweepStyles(els: (HTMLElement | null)[]) {
	for (const el of els) {
		if (!el) continue;
		el.style.backgroundImage = "";
		el.style.backgroundSize = "";
		el.style.backgroundPosition = "";
		el.style.backgroundClip = "";
		el.style.removeProperty("-webkit-background-clip");
		el.style.removeProperty("-webkit-text-fill-color");
	}
}

/**
 * 外层折叠组：聚合多条非正文消息的思考/工具，标题 = Working/Worked + 项目数
 * endByText：组被正文边界切分（streaming.text 在输出）→ working 信号消失时立即结束，
 * 不做滞后缓冲；否则（turn 间隙）滞后 HYSTERESIS_MS 防闪烁
 */
export function MetaGroup({
	items,
	working,
	endByText = false,
}: {
	items: MetaItem[];
	working: boolean;
	endByText?: boolean;
}) {
	const t = useT();
	const count = items.reduce((n, item) => n + (item.thinking ? 1 : 0) + item.tools.length, 0);

	// 滞后缓冲：working 信号消失后需保持 HYSTERESIS_MS 才显示 worked（turn 间隙内不闪烁）
	const [shownWorking, setShownWorking] = useState(working);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (working) {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			setShownWorking(true);
		} else if (shownWorking) {
			if (endByText) {
				// 正文已出现：组立即结束，避免与正文后的新预览重叠
				setShownWorking(false);
				return;
			}
			if (!timerRef.current) {
				timerRef.current = setTimeout(() => {
					timerRef.current = null;
					setShownWorking(false);
				}, HYSTERESIS_MS);
			}
		}
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, [working, shownWorking, endByText]);

	const labelRef = useRef<HTMLSpanElement>(null);
	const tickerWrapRef = useRef<HTMLDivElement>(null);

	// 统一扫光：Working 标签与预览行工具名共享同一条光带（同一背景宽度+逐帧同步位移，
	// 范围 = Working 左缘 → tool name 右缘；参数摘要保持实心不参与）。
	// 纯 CSS 方案不可行：祖先 background-clip:text 会被 ticker 的 mask/transform 打断（子元素文字不渲染），
	// 各自 shimmer-sweep 则是两条相位/宽度独立的光带
	useEffect(() => {
		if (!shownWorking) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const label = labelRef.current;
		if (!label) return;
		let raf = 0;
		const start = performance.now();
		const tick = (now: number) => {
			// 切换动画期间新旧两行并存：全部纳入（同 x 位置堆叠，范围不变，新行立即有扫光）
			const nameEls = Array.from(
				tickerWrapRef.current?.querySelectorAll<HTMLElement>("[data-shimmer-name]") ?? [],
			);
			const targets: HTMLElement[] = [label, ...nameEls];
			const rects = targets.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
			if (rects.length > 0) {
				const left = Math.min(...rects.map((r) => r.left));
				const right = Math.max(...rects.map((r) => r.right));
				const w = Math.max(right - left, 1);
				// 背景宽 2w，高光带中心在背景 50% 处；中心（range 相对坐标）从 -0.2w → 1.2w 单向循环
				//（与 .shimmer-sweep 的 120%→-20% 同为左→右）；元素背景左缘 = centerRel - w - 元素在 range 内偏移
				const progress = ((now - start) % SWEEP_MS) / SWEEP_MS;
				const centerRel = -0.2 * w + progress * 1.4 * w;
				for (const el of targets) {
					const rect = el.getBoundingClientRect();
					if (rect.width === 0) continue;
					el.style.backgroundImage = SWEEP_GRADIENT;
					el.style.backgroundSize = `${w * 2}px 100%`;
					el.style.backgroundPosition = `${centerRel - w - (rect.left - left)}px 0px`;
					el.style.backgroundClip = "text";
					el.style.setProperty("-webkit-background-clip", "text");
					el.style.setProperty("-webkit-text-fill-color", "transparent");
				}
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
			clearSweepStyles([
				labelRef.current,
				...Array.from(tickerWrapRef.current?.querySelectorAll<HTMLElement>("[data-shimmer-name]") ?? []),
			]);
		};
	}, [shownWorking]);

	const rows = items.flatMap((item, i) => [
		// biome-ignore lint/suspicious/noArrayIndexKey: 折叠组内项无独立 id，列表顺序稳定
		item.thinking ? <ThinkingRow key={`thinking-${i}`} thinking={item.thinking} /> : null,
		...item.tools.map((tool) => <ToolCallCard key={tool.key} tool={tool} />),
	]);
	// orb 状态（名字是包的渲染器名，与我们的语义不同名）：
	// tool 运行中 → connecting（星座连线 + 信号跑边）
	// 纯 thinking → working（粒子轨道，转速更快）
	// （必须在 liveItems 之前推导，因为 liveItems 会过滤掉 thinking）
	const latestActivity = useMemo(() => {
		for (let i = items.length - 1; i >= 0; i--) {
			const activity = items[i].activity;
			if (activity && activity.length > 0) {
				return activity[activity.length - 1];
			}
		}
		return undefined;
	}, [items]);
	const isTool = latestActivity?.kind === "tool";
	const orbState: OrbState = isTool ? "connecting" : "working";
	const labelKey = isTool ? "message.working" : "message.thinkingLabel";

	// 实时预览：流式项的活动序列按到达顺序展开（latest-wins，预览行显示最后一条）
	// 过滤掉 thinking：只显示 tool call，避免与标签栏的“思考中”重复
	const liveItems = useMemo<LivePreviewItem[]>(() => {
		const out: LivePreviewItem[] = [];
		for (const item of items) {
			if (!item.activity) continue;
			for (const entry of item.activity) {
				if (entry.kind === "tool") {
					out.push({
						kind: "tool",
						id: entry.id,
						name: entry.name ?? "tool",
						args: entry.args ?? "",
					});
				}
			}
		}
		return out;
	}, [items]);

	/** 单条已结束（如正文前的思考）直接裸行展示，不套 "已完成 · 1" 外壳 */
	const showWrapper = count >= 2 || shownWorking;
	if (!showWrapper) {
		return <div className="flex flex-col gap-1.5">{rows}</div>;
	}

	return (
		// -mb-3：抵消 MessageList gap-6 的一部分，状态行与后续正文/消息间距收紧
		<div className="-mb-3">
			{/* min-h-6：与内联预览行（h-6）等高，working/worked 切换行高不变 */}
			<details className="group/outer peer">
				<summary className="group/row flex min-h-6 cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
					<div className="flex shrink-0 items-center gap-2">
						{shownWorking && <ThinkingOrb state={orbState} size={20} paused={false} />}
						<span
							ref={labelRef}
							className="text-[14px] font-bold text-ink-dim transition-colors group-hover/row:text-ink"
						>
							{t(shownWorking ? labelKey : "message.worked")}
							{count > 0 && <span className="ml-1 font-normal text-ink-faint">· {count}</span>}
						</span>
					</div>
					{/* 实时预览内联进标题行（单行截断，展开组时隐藏）：工作中与完成后恒为一行高，消除布局抖动 */}
					{shownWorking && (
						<div ref={tickerWrapRef} className="min-w-0 flex-1 group-open/outer:hidden">
							<PreviewTicker items={liveItems} reserveSpace />
						</div>
					)}
					<ExpandArrowIcon className="shrink-0 text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2 group-open/outer:rotate-90" />
				</summary>
				<div className="flex flex-col gap-1.5 py-1">{rows}</div>
			</details>
		</div>
	);
}
