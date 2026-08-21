import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ActivityTickerSnapshot, createActivityTicker } from "./activity-ticker";
import { StreamingMarquee } from "./StreamingMarquee";
import { displayName } from "./ToolCallCard";

/** 预览条目（由 MetaGroup 从流式 activity 派生，按到达顺序） */
export type LivePreviewItem =
	| { kind: "thinking"; id: string; text: string }
	| { kind: "tool"; id: string; name: string; text: string };

type CurrentSlot = LivePreviewItem;

/** thinking 行的固定身份在 MetaGroup；此处只显示对应的流式正文。 */
function ThinkingPreviewRow({ text }: { text: string }) {
	return (
		<div className="flex min-w-0 items-center py-0.5 text-[13px] text-ink-dim">
			<StreamingMarquee text={text} />
		</div>
	);
}

/** 工具名保持固定，参数原文作为流式正文横移；不沿用 ToolCallCard 的摘要逻辑。 */
function ToolPreviewRow({ name, text }: { name: string; text: string }) {
	return (
		<div className="flex min-w-0 items-center gap-2 py-0.5">
			<span data-shimmer-name className="sweep-target shrink-0 font-mono text-[13px] text-ink-working">
				{displayName(name)}
			</span>
			{text && <StreamingMarquee text={text} />}
		</div>
	);
}

function rowOf(slot: CurrentSlot) {
	return slot.kind === "tool" ? (
		<ToolPreviewRow name={slot.name} text={slot.text} />
	) : (
		<ThinkingPreviewRow text={slot.text} />
	);
}

/** 上滑切换动画时长（恒定；需与 globals.css 的 0.32s 同步） */
const ANIMATION_MS = 320;
/** 动画兜底清理：prefers-reduced-motion 或 animationend 丢失时也能移除旧行 */
const PREV_CLEANUP_MS = ANIMATION_MS + 60;

/**
 * 工作中预览行：永远显示最新一条活动（latest-wins）。
 * - 新活动上滑替换旧的；最小停留期内的爆发合并为最新一条（调度见 activity-ticker.ts）
 * - 同一活动内容增长只更新内容，不触发切换动画
 * - 切换动画串行化：一次滑入/滑出必放完，期间到达的切换合并为最新、在动画结束瞬间提交
 * - 无活动且无在屏动画时不渲染（思考中只在真 thinking 流式时出现）
 * - reserveSpace 时渲染空占位行，避免 tool call 间隙造成布局跳动
 */
export function PreviewTicker({
	items,
	reserveSpace = false,
}: {
	items: LivePreviewItem[];
	reserveSpace?: boolean;
}) {
	const [ticker] = useState(createActivityTicker);
	const [snap, setSnap] = useState<ActivityTickerSnapshot>(() => ticker.peek());
	const [shown, setShownState] = useState<CurrentSlot | null>(null);
	const [previous, setPrevious] = useState<CurrentSlot | null>(null);
	const shownRef = useRef<CurrentSlot | null>(null);
	const desiredRef = useRef<CurrentSlot | null>(null);
	/** 当前切换动画的结束时刻（此前不得发起下一次切换） */
	const animUntilRef = useRef(0);

	const slots = useMemo(() => items.map((item) => ({ id: item.id, kind: item.kind })), [items]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: ticker 由 useState 惰性初始化，实例跨渲染恒定
	useEffect(() => {
		const next = ticker.ingest(slots, Date.now());
		setSnap((current) =>
			current.currentId === next.currentId && current.switchAt === next.switchAt ? current : next,
		);
	}, [slots]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: ticker 实例跨渲染恒定
	useEffect(() => {
		if (!snap.switchAt) return;
		const delay = Math.max(0, snap.switchAt - Date.now());
		const timer = setTimeout(() => setSnap(ticker.tick(Date.now())), delay);
		return () => clearTimeout(timer);
	}, [snap]);

	const live = snap.currentId ? items.find((item) => item.id === snap.currentId) : undefined;
	const desired = live ?? null;
	desiredRef.current = desired;

	const commit = (next: CurrentSlot | null) => {
		const current = shownRef.current;
		if (current && current.id !== next?.id) setPrevious(current);
		animUntilRef.current = Date.now() + ANIMATION_MS;
		shownRef.current = next;
		setShownState(next);
	};

	// 同 id 内容增长原地更新；异 id 才提交纵向滑动。layout effect 保证进/出场同帧开始。
	// biome-ignore lint/correctness/useExhaustiveDependencies: commit/refs 均为稳定引用
	useLayoutEffect(() => {
		const current = shownRef.current;
		if (desired && desired.id === current?.id) {
			if (
				desired.kind !== current.kind ||
				desired.text !== current.text ||
				(desired.kind === "tool" && current.kind === "tool" && desired.name !== current.name)
			) {
				shownRef.current = desired;
				setShownState(desired);
			}
			return;
		}
		if (desired === null && current === null) return;
		const wait = animUntilRef.current - Date.now();
		if (wait <= 0) {
			commit(desired);
			return;
		}
		const timer = setTimeout(() => commit(desiredRef.current), wait);
		return () => clearTimeout(timer);
	}, [desired]);

	useEffect(() => {
		if (!previous) return;
		const timer = setTimeout(() => setPrevious(null), PREV_CLEANUP_MS);
		return () => clearTimeout(timer);
	}, [previous]);

	if (!shown && !previous) return reserveSpace ? <div className="relative h-6 overflow-hidden" /> : null;

	return (
		<div className="relative h-6 overflow-hidden text-ink-dim [mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]">
			{previous && (
				<div key={`prev-${previous.id}`} className="preview-slide-out absolute inset-x-0 top-0">
					{rowOf(previous)}
				</div>
			)}
			{shown && (
				<div key={`cur-${shown.id}`} className="preview-slide-in absolute inset-x-0 top-0">
					{rowOf(shown)}
				</div>
			)}
		</div>
	);
}
