import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type MenuAnchor, placeMenu } from "./place-menu";

/** 菜单项规格（设计语言：无边框、无分隔线、无危险色 —— 危险操作不进本组件） */
export interface ContextMenuItem {
	key: string;
	label: string;
	/** 13px 图标（颜色由组件统一给 ink-dim → hover ink） */
	icon?: ReactNode;
	onSelect: () => void;
}

/**
 * 通用右键菜单（会话胶囊 / 轮末文件行共用）：portal 到 body（不被 tabbar 的 overflow 裁剪），
 * 锚在触发元素下沿左对齐，超右缘左翻、下方不足上翻（定位规则在 place-menu）。
 * 关闭：点浮层外（pointerdown 捕获）/ Esc / 选中任一项 / 滚动与窗口尺寸变化（防浮层脱锚）。
 */
export function ContextMenu({
	anchor,
	items,
	onClose,
}: {
	anchor: MenuAnchor;
	items: ContextMenuItem[];
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	// 先渲染再测量真实尺寸定位（尺寸由 items 行数决定），测量前整层不可见防抖动
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		setPos(placeMenu(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
	}, [anchor]);

	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current?.contains(e.target as Node)) return;
			onClose();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		// pointerdown 用捕获阶段：点其他胶囊要「切会话 + 关菜单」同时发生，不等冒泡
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", onClose);
		window.addEventListener("scroll", onClose, true);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", onClose);
			window.removeEventListener("scroll", onClose, true);
		};
	}, [onClose]);

	return createPortal(
		<div
			ref={ref}
			role="menu"
			className="no-drag fixed z-50 w-44 rounded-xl bg-surface p-1 shadow-pop"
			style={{
				left: pos?.x ?? 0,
				top: pos?.y ?? 0,
				visibility: pos ? "visible" : "hidden",
			}}
		>
			{items.map((item) => (
				<button
					key={item.key}
					type="button"
					role="menuitem"
					className="group/item flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink"
					onClick={() => {
						item.onSelect();
						onClose();
					}}
				>
					{item.icon !== undefined && (
						<span className="flex shrink-0 text-ink-dim transition-colors group-hover/item:text-ink">
							{item.icon}
						</span>
					)}
					<span className="truncate">{item.label}</span>
				</button>
			))}
		</div>,
		document.body,
	);
}
