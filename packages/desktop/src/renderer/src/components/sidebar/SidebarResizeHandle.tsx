import { clampSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@percho/shared";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
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
 * 3. 收尾**幂等**：所有收尾路径都走 `finish()`，靠 ref 判重，重复调用无副作用。
 *
 * **收尾路径必须有多条兜底（X3，2026-10-07）**：指针在**窗口外**松手时浏览器不会把 `pointerup` 送给页面
 * （拖到屏幕边缘继续拖最容易发生），只挂 `pointerup`/`pointercancel` 会永久卡在拖动态 —— 表现是整窗光标
 * 一直 `col-resize`、`is-resizing` 摘不掉、之后**再也拖不动**（要刷新页面）。所以：
 * - `onPointerMove` 里 `event.buttons === 0` → 收尾（**主路径**：用户把鼠标移回窗口内立刻自愈；实测见 IMPL-NOTES X3）；
 * - `onLostPointerCapture` → 收尾（捕获真丢了时的官方信号。注意实测：Chromium 里**脚本调用**
 *   `releasePointerCapture()` 不会触发这个事件，所以它只是兜底之一，不能当唯一退路）；
 * - `window` 的 `blur` / `document` 的 `visibilitychange` → 收尾（切窗口/切应用时松手的情形）。
 *
 * 视觉反馈复用 `.sidebar` 上已有的分界发丝线（`.sidebar:has(把手:hover)::after` + `.sidebar.is-resizing::after`），
 * **不新增第二条竖线**。
 */
export function SidebarResizeHandle({ value, onResizingChange }: SidebarResizeHandleProps) {
	const t = useT();
	const previewSidebarWidth = useUiPreferencesStore((s) => s.previewSidebarWidth);
	const commitSidebarWidth = useUiPreferencesStore((s) => s.commitSidebarWidth);
	const handleRef = useRef<HTMLHRElement | null>(null);
	const draggingRef = useRef(false);
	const pointerIdRef = useRef<number | null>(null);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);

	const finish = useCallback(() => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		const pointerId = pointerIdRef.current;
		pointerIdRef.current = null;
		document.body.style.cursor = "";
		onResizingChange(false);
		commitSidebarWidth();
		const handle = handleRef.current;
		if (handle && pointerId !== null && handle.hasPointerCapture(pointerId)) {
			handle.releasePointerCapture(pointerId);
		}
	}, [commitSidebarWidth, onResizingChange]);

	// 兜底之三：切窗口 / 切应用 / 窗口被隐藏时收尾（这些情形下 `pointerup` 一样可能收不到）
	useEffect(() => {
		const onBlurOrHide = () => finish();
		window.addEventListener("blur", onBlurOrHide);
		document.addEventListener("visibilitychange", onBlurOrHide);
		return () => {
			window.removeEventListener("blur", onBlurOrHide);
			document.removeEventListener("visibilitychange", onBlurOrHide);
		};
	}, [finish]);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLHRElement>) => {
			if (event.button !== 0 || draggingRef.current) return;
			draggingRef.current = true;
			handleRef.current = event.currentTarget;
			pointerIdRef.current = event.pointerId;
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
		(event: ReactPointerEvent<HTMLHRElement>) => {
			if (!draggingRef.current) return;
			// 兜底之一（X3 的自愈路径）：松手事件丢了时，后续 move 的 buttons 会是 0
			if (event.buttons === 0) {
				finish();
				return;
			}
			previewSidebarWidth(clampSidebarWidth(startWidthRef.current + (event.clientX - startXRef.current)));
		},
		[finish, previewSidebarWidth],
	);

	return (
		// `<hr>` 的隐式 role 就是 `separator`（spec §5.5 的契约）：显式写 role 反而被 lint 判冗余
		<hr
			ref={handleRef}
			className="sidebar-resize-handle"
			data-sidebar-resize-handle=""
			aria-orientation="vertical"
			aria-label={t("sidebar.resizeHandle")}
			aria-valuemin={SIDEBAR_MIN_WIDTH}
			aria-valuemax={SIDEBAR_MAX_WIDTH}
			aria-valuenow={value}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={finish}
			onPointerCancel={finish}
			onLostPointerCapture={finish}
		/>
	);
}
