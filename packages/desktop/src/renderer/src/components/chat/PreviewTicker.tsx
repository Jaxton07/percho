import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { type ActivityTickerSnapshot, createActivityTicker } from "./activity-ticker";
import { displayName, summarizeArgs } from "./ToolCallCard";

/** 预览条目（由 MetaGroup 从流式 activity 派生，按到达顺序） */
export type LivePreviewItem =
	| { kind: "tool"; id: string; name: string; args: string }
	| { kind: "thinking"; id: string };

/** 当前屏上的 slot（渲染用） */
interface CurrentSlot {
	id: string;
	kind: "tool" | "thinking";
	name?: string;
	args?: string;
}

/** thinking 预览行：只有"思考中"标签，不显示思考内容 */
function ThinkingPreviewRow() {
	const t = useT();
	return (
		<div className="flex items-center gap-2 py-0.5">
			<span className="shrink-0 text-[13px] font-semibold text-ink-dim">{t("message.thinkingPreview")}</span>
		</div>
	);
}

/** tool 预览行：工具名 + 参数摘要（单行截断），不可展开；参数随流式增长原地更新 */
function ToolPreviewRow({ name, args }: { name: string; args: string }) {
	const summary = summarizeArgs(args);
	return (
		<div className="flex items-center gap-2 py-0.5">
			<span className="shrink-0 font-mono text-[13px] font-semibold text-ink-dim">{displayName(name)}</span>
			{summary && (
				<span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-faint">{summary}</span>
			)}
		</div>
	);
}

function rowOf(slot: CurrentSlot): ReactNode {
	return slot.kind === "tool" && slot.name ? (
		<ToolPreviewRow name={slot.name} args={slot.args ?? ""} />
	) : (
		<ThinkingPreviewRow />
	);
}

/** 上滑切换动画时长（恒定；需与 globals.css 的 0.32s 同步） */
const ANIMATION_MS = 320;
/** 动画兜底清理：prefers-reduced-motion 或 animationend 丢失时也能移除旧行 */
const PREV_CLEANUP_MS = ANIMATION_MS + 60;

/**
 * 工作中预览行：永远显示最新一条活动（latest-wins）。
 * - 新活动上滑替换旧的；最小停留期内的爆发合并为最新一条（调度见 activity-ticker.ts）
 * - 同一活动参数增长只更新内容，不触发切换动画
 * - 切换动画串行化：一次滑入/滑出必放完，期间到达的切换合并为最新、在动画结束瞬间提交；
 *   活动清空也走滑出动画（不瞬时卸载）
 * - 无活动且无在屏动画时不渲染（思考中只在真 thinking 流式时出现）
 */
export function PreviewTicker({ items }: { items: LivePreviewItem[] }) {
	// useState 惰性初始化：调度器实例跨渲染稳定（同一引用）
	const [ticker] = useState(createActivityTicker);
	const [snap, setSnap] = useState<ActivityTickerSnapshot>(() => ticker.peek());
	const [shown, setShownState] = useState<CurrentSlot | null>(null);
	const [previous, setPrevious] = useState<CurrentSlot | null>(null);
	const shownRef = useRef<CurrentSlot | null>(null);
	const desiredRef = useRef<CurrentSlot | null>(null);
	/** 当前切换动画的结束时刻（此前不得发起下一次切换） */
	const animUntilRef = useRef(0);

	const slots = useMemo(() => items.map((i) => ({ id: i.id, kind: i.kind })), [items]);

	// 调度：items 变化（新活动/参数增长）→ latest-wins 判定；快照未变时保持旧引用 bail out
	// biome-ignore lint/correctness/useExhaustiveDependencies: ticker 由 useState 惰性初始化，实例跨渲染恒定
	useEffect(() => {
		const next = ticker.ingest(slots, Date.now());
		setSnap((prev) => (prev.currentId === next.currentId && prev.switchAt === next.switchAt ? prev : next));
	}, [slots]);

	// 最小停留到点 → 切到最新（合并停留期间到达的多条）
	// biome-ignore lint/correctness/useExhaustiveDependencies: ticker 实例跨渲染恒定
	useEffect(() => {
		if (!snap.switchAt) return;
		const delay = Math.max(0, snap.switchAt - Date.now());
		const timer = setTimeout(() => setSnap(ticker.tick(Date.now())), delay);
		return () => clearTimeout(timer);
	}, [snap]);

	// 目标 slot：无活动 → null（走滑出后消失）
	const live = snap.currentId ? items.find((i) => i.id === snap.currentId) : undefined;
	const desired: CurrentSlot | null = live
		? live.kind === "tool"
			? { id: live.id, kind: "tool", name: live.name, args: live.args }
			: { id: live.id, kind: "thinking" }
		: null;
	desiredRef.current = desired;

	// 提交切换：旧行挪到 previous 滑出，新行上屏；此后 ANIMATION_MS 内不再切换（动画放完）
	const commit = (next: CurrentSlot | null) => {
		const cur = shownRef.current;
		if (cur && cur.id !== next?.id) setPrevious(cur);
		animUntilRef.current = Date.now() + ANIMATION_MS;
		shownRef.current = next;
		setShownState(next);
	};

	// 切换决策：同 id → 原地内容更新；异 id → 动画空闲立即提交，动画中延迟到放完
	// （延迟期间 desired 继续更新，提交时取最新 → 爆发合并为一跳，每跳都是完整动画）。
	// 必须用 useLayoutEffect（paint 前同步 flush）：旧行滑出与新行滑入同一帧开始
	// biome-ignore lint/correctness/useExhaustiveDependencies: commit/ refs 均为稳定引用
	useLayoutEffect(() => {
		const cur = shownRef.current;
		if (desired && desired.id === cur?.id) {
			// 同一活动参数增长：内容原地更新（不动画、不重置计时）
			if (desired.name !== cur.name || desired.args !== cur.args) {
				shownRef.current = desired;
				setShownState(desired);
			}
			return;
		}
		if (desired === null && cur === null) return;
		const wait = animUntilRef.current - Date.now();
		if (wait <= 0) {
			commit(desired);
			return;
		}
		const timer = setTimeout(() => commit(desiredRef.current), wait);
		return () => clearTimeout(timer);
	}, [desired]);

	// previous 兜底清理（动画未触发 / motion-reduce 时也能移除）
	useEffect(() => {
		if (!previous) return;
		const timer = setTimeout(() => setPrevious(null), PREV_CLEANUP_MS);
		return () => clearTimeout(timer);
	}, [previous]);

	if (!shown && !previous) return null;

	return (
		// 上下边缘 mask 渐隐：滑入/滑出行穿过容器边界时柔化，避免硬裁切边（静态行文字居中不受影响）
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
