import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionBusy, useSessionReadOnly } from "../../hooks/use-session-state";
import { useT } from "../../i18n";
import { COMPOSER_FOCUS_EVENT, useDraftStore } from "../../stores/drafts";
import { isDraftSessionId, useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";

/** 菜单与选区的间距 */
const GAP = 8;
/** 水平 clamp 的半宽估计（菜单实际宽约 230px，超出按 clamp 边距轻微偏移可接受） */
const HALF_WIDTH = 120;

interface SelectionState {
	text: string;
	rect: DOMRect;
}

/**
 * 对话区选中文字浮出菜单：「添加到对话」（引用胶囊进输入框）/「在新会话继续」（fork + 胶囊）。
 * selectionchange 只缓存选区（拖选过程不闪现），mouseup 才显示；菜单 onMouseDown
 * preventDefault 防点击瞬间选区塌陷，动作消费缓存文本而非重读 selection。
 * 只读会话（subagent 检视）不弹；「在新会话继续」在 agent 运行/压缩中禁用（fork 被后端拒绝）。
 */
export function SelectionToolbar({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const readOnly = useSessionReadOnly();
	const busy = useSessionBusy(activeSessionId);
	const [pending, setPending] = useState<SelectionState | null>(null);
	const [visible, setVisible] = useState(false);
	const [forking, setForking] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const visibleRef = useRef(false);
	/** 上/下放置：true = 选区上方（translate -100%），false = 下方 */
	const [above, setAbove] = useState(true);

	visibleRef.current = visible;

	const hide = useCallback(() => {
		setVisible(false);
		setPending(null);
	}, []);

	/** 选区归属判定：锚点在对话滚动容器内且不在菜单自身内 */
	const ownsSelection = useCallback(() => {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const container = containerRef.current;
		const menu = menuRef.current;
		const node = sel.anchorNode;
		if (!node || !container?.contains(node) || menu?.contains(node)) return null;
		const text = sel.toString().trim();
		if (!text) return null;
		return { text, rect: sel.getRangeAt(0).getBoundingClientRect() };
	}, [containerRef]);

	// selectionchange：非空选区持续缓存（拖选过程不显示，等 mouseup）；塌陷即收起
	useEffect(() => {
		if (readOnly) return;
		const onChange = () => {
			const owned = ownsSelection();
			if (!owned) {
				if (visibleRef.current) hide();
				return;
			}
			setPending(owned);
		};
		document.addEventListener("selectionchange", onChange);
		return () => document.removeEventListener("selectionchange", onChange);
	}, [readOnly, ownsSelection, hide]);

	// mouseup 显示 / pointerdown 外点收起 / scroll·resize 跟随重算
	useEffect(() => {
		if (readOnly) return;
		let raf = 0;
		const syncPosition = () => {
			const owned = ownsSelection();
			if (!owned) {
				hide();
				return;
			}
			setPending(owned);
		};
		const onMouseUp = () => {
			const owned = ownsSelection();
			if (!owned) return;
			// 顶部放不下则翻到选区下方
			setAbove(owned.rect.top > 120);
			setPending(owned);
			setVisible(true);
		};
		const onPointerDown = (e: PointerEvent) => {
			if (!visibleRef.current) return;
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) hide();
		};
		const onScroll = () => {
			if (!visibleRef.current) return;
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(syncPosition);
		};
		document.addEventListener("mouseup", onMouseUp);
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);
		return () => {
			cancelAnimationFrame(raf);
			document.removeEventListener("mouseup", onMouseUp);
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onScroll);
		};
	}, [readOnly, ownsSelection, hide]);

	// 会话切换即收起（旧选区/旧定位不再有意义）
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeSessionId 是刻意的重跑触发器（切换会话时收起旧菜单）
	useEffect(() => {
		hide();
	}, [activeSessionId, hide]);

	/** 清除选区并收起（动作完成后调用，避免残留高亮） */
	const consume = useCallback(() => {
		window.getSelection()?.removeAllRanges();
		hide();
	}, [hide]);

	const addToChat = () => {
		if (!pending || !activeSessionId) return;
		// 同文已引用则跳过（引用文本兼作 React key，保持唯一）
		useDraftStore
			.getState()
			.updateDraft(activeSessionId, (d) =>
				d.quotes.includes(pending.text) ? d : { ...d, quotes: [...d.quotes, pending.text] },
			);
		window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT));
		consume();
	};

	const continueInNewChat = async () => {
		if (!pending || busy || forking || !activeSessionId || isDraftSessionId(activeSessionId)) return;
		const messages = useTranscriptStore.getState().bySession[activeSessionId]?.messages ?? [];
		const lastAssistant = [...messages].reverse().find((m) => m.kind === "assistant");
		if (!lastAssistant) return;
		const quote = pending.text;
		const ref = lastAssistant.entryId
			? { entryId: lastAssistant.entryId }
			: { text: lastAssistant.sourceText ?? lastAssistant.text };
		setForking(true);
		try {
			const newId = await useSessionsStore.getState().forkSession(ref);
			if (!newId) return;
			useDraftStore.getState().updateDraft(newId, (d) => ({ ...d, quotes: [...d.quotes, quote] }));
			window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT));
			consume();
		} finally {
			setForking(false);
		}
	};

	if (!visible || !pending || readOnly) return null;
	const { rect } = pending;
	const left = Math.min(
		Math.max(rect.left + rect.width / 2, HALF_WIDTH + 8),
		window.innerWidth - HALF_WIDTH - 8,
	);
	// 跨视口边界选择时 rect 可能越界：菜单整体 clamp 在视口内（48 ≈ 菜单高含 padding）
	const top = Math.min(Math.max(above ? rect.top - GAP : rect.bottom + GAP, 8), window.innerHeight - 48);

	return (
		<div
			ref={menuRef}
			role="menu"
			className="selection-pop fixed z-50 flex items-center gap-0.5 rounded-xl bg-surface p-1 shadow-pop"
			style={{
				left,
				top,
				transform: `translate(-50%, ${above ? "-100%" : "0"})`,
			}}
			onMouseDown={(e) => e.preventDefault()}
		>
			<button type="button" role="menuitem" className="selection-menu-btn" onClick={addToChat}>
				{t("selection.addToChat")}
			</button>
			<span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
			<button
				type="button"
				role="menuitem"
				className="selection-menu-btn disabled:opacity-40"
				disabled={busy || forking}
				title={busy ? t("selection.busyHint") : undefined}
				onClick={() => void continueInNewChat()}
			>
				{t("selection.continueNew")}
			</button>
		</div>
	);
}
