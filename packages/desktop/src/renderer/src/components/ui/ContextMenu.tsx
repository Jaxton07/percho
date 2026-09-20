import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type MenuAnchor, placeMenu } from "./place-menu";

/** 菜单项规格（设计语言：有边框卡片 + 分隔线 + 危险红项，设计稿画板 D） */
export interface ContextMenuItem {
	key: string;
	label: string;
	/** 13px 图标（颜色由组件统一给 ink-dim → hover ink） */
	icon?: ReactNode;
	/** 危险项（删除类）：红字；hover 仍是 bg-hover 底，不改成 ink */
	danger?: boolean;
	/** 在本项之前画一条分隔线（分隔常规操作与危险操作） */
	separatorBefore?: boolean;
	onSelect: () => void;
}

/**
 * 通用右键菜单（会话胶囊 / 轮末文件行 / 左侧栏会话行共用）：portal 到 body（不被 tabbar 的 overflow 裁剪），
 * 锚在触发元素下沿左对齐，超右缘左翻、下方不足上翻（定位规则在 place-menu）。
 * 关闭：点浮层外（pointerdown 捕获）/ Esc / 选中任一项 / 滚动与窗口尺寸变化（防浮层脱锚）。
 * 外观：`rounded-xl border border-border bg-surface p-1 shadow-pop` 的有边框卡片（与左栏共用一套，
 * 不再有 veil 渐变变体）；项高 30px、图标与文字各 13px、危险项红字**且图标同红**、分隔线 `h-px bg-border`。
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

	const renderRow = (item: ContextMenuItem) => (
		<Fragment key={item.key}>
			{item.separatorBefore && <div className="mx-1.5 my-1 h-px bg-border" />}
			<button
				type="button"
				role="menuitem"
				className={`group/item flex h-[30px] w-full items-center gap-[10px] rounded-[7px] px-2 text-left text-[13px] transition-colors hover:bg-hover ${
					item.danger ? "text-red-600" : "text-ink-2 hover:text-ink"
				}`}
				onClick={() => {
					item.onSelect();
					onClose();
				}}
			>
				{item.icon !== undefined && (
					<span
						className={`flex shrink-0 transition-colors ${
							item.danger ? "text-red-600" : "text-ink-dim group-hover/item:text-ink"
						}`}
					>
						{item.icon}
					</span>
				)}
				<span className="truncate">{item.label}</span>
			</button>
		</Fragment>
	);
	return createPortal(
		<div
			ref={ref}
			role="menu"
			className="no-drag fixed z-50 w-44 rounded-xl border border-border bg-surface p-1 shadow-pop"
			style={{
				left: pos?.x ?? 0,
				top: pos?.y ?? 0,
				visibility: pos ? "visible" : "hidden",
			}}
		>
			{items.map(renderRow)}
		</div>,
		document.body,
	);
}
