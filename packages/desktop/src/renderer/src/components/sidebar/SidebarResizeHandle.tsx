import { clampSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@percho/shared";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useRef } from "react";
import { useT } from "../../i18n";
import { useUiPreferencesStore } from "../../stores/ui-preferences";

interface SidebarResizeHandleProps {
	/** 当前渲染宽：只用于 separator 的可访问性取值（宽度变了读屏能念出来） */
	value: number;
	/** 拖动态开关：Sidebar 用它给 `.sidebar` 挂 `is-resizing`（拖动中必须关掉 width 过渡，否则手感是橡皮筋） */
	onResizingChange: (resizing: boolean) => void;
}

/**
 * 左侧栏宽度拖拽把手（命中区 = 贴右缘内侧 8px 的透明条）。
 *
 * 三条不变量（阶段 0 实测定下来的）：
 * 1. **起点取 store 的用户意图值**，不取 DOM 宽 —— DOM 宽可能已被「容器宽-聊天列最小宽」夹过，用它当起点会漂移；
 * 2. 拖动中只 `previewSidebarWidth`（内存），`pointerup` 才 `commitSidebarWidth`（落盘）；
 * 3. 收尾**幂等**：`pointerup` / `pointercancel` 都走 `finish()`，靠 ref 判重，切会话/失焦也不会卡在拖动态。
 *
 * 视觉反馈复用 `.sidebar` 上已有的分界发丝线（`.sidebar:has(把手:hover)::after` + `.sidebar.is-resizing::after`），
 * **不新增第二条竖线**。
 */
export function SidebarResizeHandle({ value, onResizingChange }: SidebarResizeHandleProps) {
	const t = useT();
	const previewSidebarWidth = useUiPreferencesStore((s) => s.previewSidebarWidth);
	const commitSidebarWidth = useUiPreferencesStore((s) => s.commitSidebarWidth);
	const draggingRef = useRef(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);

	const finish = useCallback(
		(element: HTMLElement, pointerId: number) => {
			if (!draggingRef.current) return;
			draggingRef.current = false;
			document.body.style.cursor = "";
			onResizingChange(false);
			commitSidebarWidth();
			if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
		},
		[commitSidebarWidth, onResizingChange],
	);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (event.button !== 0 || draggingRef.current) return;
			draggingRef.current = true;
			startXRef.current = event.clientX;
			startWidthRef.current = useUiPreferencesStore.getState().sidebarWidth;
			event.currentTarget.setPointerCapture(event.pointerId);
			document.body.style.cursor = "col-resize";
			onResizingChange(true);
			event.preventDefault();
		},
		[onResizingChange],
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!draggingRef.current) return;
			previewSidebarWidth(clampSidebarWidth(startWidthRef.current + (event.clientX - startXRef.current)));
		},
		[previewSidebarWidth],
	);

	return (
		// `<hr>` 的隐式 role 就是 `separator`（spec §5.5 的契约）：显式写 role 反而被 lint 判冗余
		<hr
			className="sidebar-resize-handle"
			data-sidebar-resize-handle=""
			aria-orientation="vertical"
			aria-label={t("sidebar.resizeHandle")}
			aria-valuemin={SIDEBAR_MIN_WIDTH}
			aria-valuemax={SIDEBAR_MAX_WIDTH}
			aria-valuenow={value}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={(event) => finish(event.currentTarget, event.pointerId)}
			onPointerCancel={(event) => finish(event.currentTarget, event.pointerId)}
		/>
	);
}
