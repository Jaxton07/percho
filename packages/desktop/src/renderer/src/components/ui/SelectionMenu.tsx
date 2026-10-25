import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon } from "../icons";
import { anchorOfElement, placeMenu } from "./place-menu";

/** 点击式选择列表；与工作台浮层共用定位，不受设置页滚动淡出裁剪。 */
export function SelectionMenu({
	anchor,
	field,
	label,
	options,
	value,
	onSelect,
	onClose,
}: {
	anchor: HTMLElement;
	/** 可输入选择器：列表固定在整个字段下方，并与字段等宽。 */
	field?: HTMLElement;
	label: string;
	options: { value: string; label: string }[];
	value: string;
	onSelect: (value: string) => void;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const id = useId();
	const [position, setPosition] = useState<{
		x: number;
		y: number;
		width?: number;
		maxHeight?: number;
	} | null>(null);
	const focusTrigger = () => (field?.querySelector("input") ?? anchor).focus({ preventScroll: true });
	useLayoutEffect(() => {
		const menu = ref.current;
		if (!menu) return;
		if (field) {
			const rect = field.getBoundingClientRect();
			setPosition({
				x: rect.left,
				y: rect.bottom + 4,
				width: rect.width,
				maxHeight: Math.min(240, Math.max(40, window.innerHeight - rect.bottom - 12)),
			});
			return;
		}
		setPosition(
			placeMenu(anchorOfElement(anchor), menu.getBoundingClientRect(), {
				width: window.innerWidth,
				height: window.innerHeight,
			}),
		);
	}, [anchor, field]);
	useEffect(() => {
		if (!position) return;
		const menu = ref.current;
		const selected =
			menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
			menu?.querySelector<HTMLButtonElement>('[role="option"]');
		selected?.focus({ preventScroll: true });
	}, [position]);
	useEffect(() => {
		const outside = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node) && !(field ?? anchor).contains(event.target as Node))
				onClose();
		};
		const scroll = (event: Event) => {
			if (!ref.current?.contains(event.target as Node)) onClose();
		};
		window.addEventListener("pointerdown", outside, true);
		window.addEventListener("scroll", scroll, true);
		window.addEventListener("resize", onClose);
		return () => {
			window.removeEventListener("pointerdown", outside, true);
			window.removeEventListener("scroll", scroll, true);
			window.removeEventListener("resize", onClose);
		};
	}, [anchor, field, onClose]);
	return createPortal(
		<div
			ref={ref}
			role="listbox"
			aria-label={label}
			className="fixed z-50 max-h-60 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl bg-surface p-1 shadow-pop"
			style={{
				left: position?.x ?? 0,
				top: position?.y ?? 0,
				minWidth: field
					? position?.width
					: Math.min(Math.max(anchor.offsetWidth, 180), window.innerWidth - 16),
				width: position?.width,
				maxHeight: position?.maxHeight,
				visibility: position ? "visible" : "hidden",
			}}
			onKeyDown={(event) => {
				const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
				const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
				const next =
					event.key === "Home"
						? 0
						: event.key === "End"
							? buttons.length - 1
							: event.key === "ArrowDown"
								? (index + 1) % buttons.length
								: event.key === "ArrowUp"
									? (index - 1 + buttons.length) % buttons.length
									: null;
				if (next !== null) {
					event.preventDefault();
					buttons[next]?.focus();
				}
				if ((event.key === "Enter" || event.key === " ") && index >= 0) {
					event.preventDefault();
					buttons[index]?.click();
				}
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					onClose();
					focusTrigger();
				}
				if (event.key === "Tab") {
					focusTrigger();
					onClose();
				}
			}}
		>
			{options.map((option, index) => (
				<button
					key={option.value}
					id={`${id}-${index}`}
					type="button"
					role="option"
					aria-selected={option.value === value}
					className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ui-12 text-ink-2 outline-none hover:bg-hover focus:bg-hover"
					onClick={() => {
						onSelect(option.value);
						onClose();
						focusTrigger();
					}}
				>
					<span className="min-w-0 flex-1 truncate">{option.label}</span>
					<span className="flex w-3 shrink-0">{option.value === value && <CheckIcon />}</span>
				</button>
			))}
		</div>,
		document.body,
	);
}
