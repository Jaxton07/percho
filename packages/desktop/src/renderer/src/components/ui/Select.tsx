import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "../icons";
import { anchorOfElement, type MenuAnchor, placeMenu } from "./place-menu";

const PANEL_CLASS =
	"no-drag fixed z-50 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-pop";

/** 触发按钮外观：与输入框同一套（同高、同边框、同圆角），换掉各系统原生 select */
export const SELECT_TRIGGER_CLASS =
	"flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-left text-ui-12 text-ink outline-none transition-colors hover:border-border-strong focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";

/**
 * 下拉浮层：portal 到 body 并复用 placeMenu 定位，因此不会被设置弹窗的滚动容器裁剪；
 * 点浮层外 / Esc / 滚动 / 窗口尺寸变化即关闭，避免浮层脱锚。
 */
export function Popup({
	anchor,
	width,
	onClose,
	children,
}: {
	anchor: MenuAnchor;
	width: number;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	// 先渲染再测量真实高宽定位（行数决定高度），测量前整层不可见防抖动
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		setPos(
			placeMenu(
				anchor,
				{ width: rect.width, height: rect.height },
				{ width: window.innerWidth, height: window.innerHeight },
			),
		);
	}, [anchor]);

	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current?.contains(e.target as Node)) return;
			onClose();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		window.addEventListener("keydown", onKeyDown);
		const onScroll = (e: Event) => {
			// 浮层自身滚动（长列表）不算脱锚
			if (ref.current?.contains(e.target as Node)) return;
			onClose();
		};
		window.addEventListener("resize", onClose);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown, true);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", onClose);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [onClose]);

	return createPortal(
		<div
			ref={ref}
			role="listbox"
			className={PANEL_CLASS}
			style={{
				left: pos?.x ?? 0,
				top: pos?.y ?? 0,
				width,
				visibility: pos ? "visible" : "hidden",
			}}
		>
			{children}
		</div>,
		document.body,
	);
}

/** 浮层里的可选项：行高 30px、13px 字，选中项右侧打勾，与右键菜单同一套行规格 */
export function SelectItem({
	selected,
	onSelect,
	trailing,
	children,
}: {
	selected?: boolean;
	onSelect: () => void;
	/** 行尾附注（如模型的能力摘要），比主文案小一号、更淡 */
	trailing?: ReactNode;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			role="option"
			aria-selected={selected ?? false}
			className={`flex h-[30px] w-full items-center gap-2 rounded-[7px] px-2 text-left text-ui-13 transition-colors hover:bg-hover ${
				selected ? "text-ink" : "text-ink-2 hover:text-ink"
			}`}
			onClick={onSelect}
		>
			<span className="truncate">{children}</span>
			{trailing !== undefined && (
				<span className="ml-auto shrink-0 text-ui-10 text-ink-faint">{trailing}</span>
			)}
			{selected && <CheckIcon size={13} className={`${trailing === undefined ? "ml-auto" : ""} shrink-0`} />}
		</button>
	);
}

export interface SelectOption {
	value: string;
	label: string;
}

/** 单选下拉：按钮触发 + portal 浮层，替代原生 `<select>`，保证与输入框/菜单同一套视觉 */
export function Select({
	value,
	options,
	onChange,
	className = "",
	disabled,
	ariaLabel,
}: {
	value: string;
	options: readonly SelectOption[];
	onChange: (value: string) => void;
	className?: string;
	disabled?: boolean;
	ariaLabel?: string;
}) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
	const current = options.find((option) => option.value === value);

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				role="combobox"
				aria-label={ariaLabel}
				aria-expanded={anchor !== null}
				disabled={disabled}
				className={`${SELECT_TRIGGER_CLASS} ${className}`}
				onClick={() => {
					const el = triggerRef.current;
					setAnchor((prev) => (prev ? null : el ? anchorOfElement(el) : null));
				}}
			>
				<span className="truncate">{current?.label ?? value}</span>
				<ChevronDownIcon size={9} className="ml-auto shrink-0 text-ink-faint" />
			</button>
			{anchor && (
				<Popup anchor={anchor} width={anchor.width} onClose={() => setAnchor(null)}>
					{options.map((option) => (
						<SelectItem
							key={option.value}
							selected={option.value === value}
							onSelect={() => {
								onChange(option.value);
								setAnchor(null);
							}}
						>
							{option.label}
						</SelectItem>
					))}
				</Popup>
			)}
		</>
	);
}
