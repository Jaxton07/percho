import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
/** 光带宽（px，恒定）：高光形状/宽度不随扫光并集伸缩（codex 式固定宽度高光条） */
const BAND_PX = 260;
/** 扫光速度（px/s，恒定）：周期随行程自然伸缩；并集增删只影响回绕阈值，不改写光带几何 */
const SWEEP_SPEED = 160;
/**
 * 扫光渐变（元素相对坐标）：光带位置直接烘焙进 px 色标，背景图恒铺满元素（渐变无固有尺寸）
 * → 底色永远全覆盖、文字永不消失；光带形状保持固定 260px 不随元素宽度拉伸。
 * 不能用「固定 px 图 + background-position」：no-repeat 时光带图不在元素内，文字区域无背景可
 * 裁剪（text-fill 透明 → 整段消失）；repeat 平铺则光带每 260px 重复出现。
 * 光带形状与 globals.css 的 .shimmer-sweep 一致（改则两边同步）。
 */
function bandGradient(centerRel: number): string {
	const s = centerRel - BAND_PX / 2;
	const stop = (f: number) => `${s + f * BAND_PX}px`;
	return `linear-gradient(90deg, currentColor ${stop(0)}, color-mix(in srgb, currentColor 75%, var(--shimmer-highlight)) ${stop(0.28)}, color-mix(in srgb, currentColor 30%, var(--shimmer-highlight)) ${stop(0.46)}, color-mix(in srgb, var(--shimmer-highlight) 90%, currentColor) ${stop(0.5)}, color-mix(in srgb, currentColor 30%, var(--shimmer-highlight)) ${stop(0.54)}, color-mix(in srgb, currentColor 75%, var(--shimmer-highlight)) ${stop(0.72)}, currentColor ${stop(1)})`;
}

/** 清除 rAF 扫光写在元素上的内联背景/填充样式（恢复常规文字颜色） */
function clearSweepStyles(els: (HTMLElement | null)[]) {
	for (const el of els) {
		if (!el) continue;
		el.style.backgroundImage = "";
		el.style.backgroundSize = "";
		el.style.backgroundPosition = "";
		el.style.backgroundRepeat = "";
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
	/** 供 layout effect 在扫光目标集合变化的同一帧补扫光样式（paint 前执行，消除新行首帧实色闪烁） */
	const paintRef = useRef<() => void>(() => {});

	// 统一扫光：Working 标签与预览行工具名共享同一条光带（固定图宽 + 恒定速度，视口绝对坐标）。
	// 光带几何不依赖并集宽度：工具名挂载/卸载/变长只影响回绕阈值（hi = 并集右缘 + 一整条光带），
	// 光带位置连续无瞬移；回绕两端各留一整条光带的行程，回绕时光带两侧都完全不可见 → 无缝。
	// 元素常态样式由 .sweep-target 兜底（实心 clip，视觉 = 普通文字），扫光每帧只重写 backgroundImage
	//（光带位置烘焙在渐变 px 色标里）→ 挂载与清理无闪帧。
	// 纯 CSS 方案不可行：祖先 background-clip:text 会被 ticker 的 mask/transform 打断（子元素文字不渲染），
	// 各自 shimmer-sweep 则是两条相位/宽度独立的光带
	useEffect(() => {
		if (!shownWorking) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const label = labelRef.current;
		if (!label) return;
		// 光带中心（视口绝对 x）；NaN = 首帧初始化：放在并集左界外（光带完全不可见处）起步
		let centerAbs = Number.NaN;
		const paint = () => {
			// 切换动画期间新旧两行并存：全部纳入（同 x 位置堆叠，新行立即有扫光）
			const nameEls = Array.from(
				tickerWrapRef.current?.querySelectorAll<HTMLElement>("[data-shimmer-name]") ?? [],
			);
			const targets: HTMLElement[] = [label, ...nameEls];
			const pairs = targets.map((el) => ({ el, rect: el.getBoundingClientRect() }));
			const visible = pairs.filter((p) => p.rect.width > 0);
			if (visible.length === 0) return;
			const left = Math.min(...visible.map((p) => p.rect.left));
			const right = Math.max(...visible.map((p) => p.rect.right));
			if (Number.isNaN(centerAbs)) centerAbs = left - BAND_PX;
			// 光带完全扫出右界（中心越过右缘 + 一整条光带）→ 回绕到左界外，两端皆不可见
			const lo = left - BAND_PX;
			const hi = right + BAND_PX;
			if (centerAbs > hi) {
				centerAbs = lo + ((centerAbs - lo) % (hi - lo));
			}
			for (const { el, rect } of pairs) {
				if (rect.width === 0) continue;
				el.style.backgroundImage = bandGradient(centerAbs - rect.left);
			}
		};
		paintRef.current = paint;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			// 切后台回来 dt 可能很大：钳制，避免光带瞬移（装饰动画，相位漂移无妨）
			const dt = Math.min(now - last, 100);
			last = now;
			centerAbs += SWEEP_SPEED * (dt / 1000);
			paint();
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
			paintRef.current = () => {};
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

	// 扫光目标集合（预览行 id）变化 → 同一帧补扫光样式：新挂载行在首次 paint 前即接上光带，
	// 否则新行有 ≤1 帧的实色空窗（光带恰好扫到它时可见闪烁）
	const liveKey = liveItems.map((i) => i.id).join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: liveKey 代表扫光目标集合变化；paintRef 由上方扫光 effect 维护
	useLayoutEffect(() => {
		if (shownWorking) paintRef.current();
	}, [liveKey, shownWorking]);

	// Working → Worked 切换：布局阶段同步清除标签上的扫光内联样式（paint 前）。
	// 被动 effect 的 cleanup 跑在 paint 后，若只等它：sweep-target 类已移除（clip 失效）而内联
	// 渐变还在 → 会有一帧未裁剪的渐变底色块闪在 Worked 文字背后
	useLayoutEffect(() => {
		if (!shownWorking) clearSweepStyles([labelRef.current]);
	}, [shownWorking]);

	/** 单条已结束（如正文前的思考）直接裸行展示，不套 "已完成 · 1" 外壳 */
	const showWrapper = count >= 2 || shownWorking;
	if (!showWrapper) {
		return <div className="flex flex-col gap-1.5">{rows}</div>;
	}

	return (
		// -mb-3：抵消 MessageList gap-6 的一部分，状态行与后续正文/消息间距收紧
		<div className="-mb-3">
			{/* min-h-6：与内联预览行（h-6）等高，working/worked 切换行高不变 */}
			<details className="group/outer peer drawer-details">
				<summary className="group/row flex min-h-6 cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
					<div className="flex shrink-0 items-center gap-2">
						{shownWorking && <ThinkingOrb state={orbState} size={20} paused={false} />}
						<span
							ref={labelRef}
							className={`text-[14px] font-bold transition-colors group-hover/row:text-ink ${
								shownWorking ? "sweep-target text-ink-working" : "text-ink-dim"
							}`}
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
