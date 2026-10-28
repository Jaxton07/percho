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
	open,
	onExited,
}: {
	anchor: HTMLElement;
	/** 可输入选择器：列表与字段等宽，空间不足时上翻；关闭后焦点回到输入框。 */
	field?: HTMLElement;
	label: string;
	options: { value: string; label: string; description?: string; disabled?: boolean }[];
	value: string;
	onSelect: (value: string) => void;
	onClose: () => void;
	/** 受控动画：关闭后暂留节点，退场完成再由调用方卸载。 */
	open?: boolean;
	onExited?: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const id = useId();
	const exitedRef = useRef(onExited);
	exitedRef.current = onExited;
	const interruptedFrame = useRef<{ opacity: string; transform: string } | null>(null);
	const [position, setPosition] = useState<{
		x: number;
		y: number;
		width?: number;
		maxHeight?: number;
	} | null>(null);
	const focusTrigger = () =>
		(field?.querySelector<HTMLInputElement>("input:not(:disabled)") ?? anchor).focus({ preventScroll: true });
	useLayoutEffect(() => {
		const menu = ref.current;
		if (!menu) return;
		if (field) {
			const rect = field.getBoundingClientRect();
			const width = Math.min(rect.width, Math.max(0, window.innerWidth - 12));
			const availableBelow = Math.max(0, window.innerHeight - rect.bottom - 10);
			const availableAbove = Math.max(0, rect.top - 10);
			const maxHeight = Math.min(240, Math.max(availableBelow, availableAbove));
			setPosition({
				...placeMenu(
					anchorOfElement(field),
					{ width, height: Math.min(menu.getBoundingClientRect().height, maxHeight) },
					{ width: window.innerWidth, height: window.innerHeight },
				),
				width,
				maxHeight,
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
	useLayoutEffect(() => {
		const menu = ref.current;
		if (!menu || !position || open === undefined) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			if (!open) exitedRef.current?.();
			return;
		}
		const offset = position.y < anchor.getBoundingClientRect().top ? 4 : -4;
		const hidden = { opacity: "0", transform: `translateY(${offset}px)` };
		const visible = { opacity: "1", transform: "translateY(0)" };
		const animation = menu.animate(
			[interruptedFrame.current ?? (open ? hidden : visible), open ? visible : hidden],
			{ duration: open ? 160 : 120, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" },
		);
		animation.onfinish = () => {
			if (!open) exitedRef.current?.();
		};
		return () => {
			const style = getComputedStyle(menu);
			interruptedFrame.current = { opacity: style.opacity, transform: style.transform };
			animation.onfinish = null;
			animation.cancel();
		};
	}, [anchor, open, position]);
	useEffect(() => {
		if (!position || open === false) return;
		const menu = ref.current;
		const selected =
			menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]:not(:disabled)') ??
			menu?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)') ??
			menu;
		selected?.focus({ preventScroll: true });
	}, [position, open]);
	useEffect(() => {
		if (open === false) return;
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
	}, [anchor, field, onClose, open]);
	return createPortal(
		<div
			ref={ref}
			role="listbox"
			tabIndex={-1}
			aria-label={label}
			aria-hidden={open === false ? true : undefined}
			inert={open === false}
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
				pointerEvents: open === false ? "none" : undefined,
			}}
			onKeyDown={(event) => {
				const buttons = [
					...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=option]:not(:disabled)") ?? []),
				];
				const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
				const next = !buttons.length
					? null
					: event.key === "Home"
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
					disabled={option.disabled}
					aria-selected={option.value === value}
					className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ui-12 text-ink-2 outline-none hover:bg-hover focus:bg-hover disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
					onClick={() => {
						onSelect(option.value);
						onClose();
						focusTrigger();
					}}
				>
					<span className="min-w-0 flex-1 truncate">{option.label}</span>
					{option.description && (
						<span className="shrink-0 text-ui-10 text-ink-faint">{option.description}</span>
					)}
					<span className="flex w-3 shrink-0">{option.value === value && <CheckIcon />}</span>
				</button>
			))}
		</div>,
		document.body,
	);
}
