import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "../icons";

/** 轻量下拉：trigger + 上弹面板，点击外部关闭 */
export function Dropdown({
	trigger,
	children,
}: {
	trigger: React.ReactNode;
	children: (close: () => void) => React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				className="flex items-center gap-1 rounded-lg px-2 py-1 transition-colors hover:bg-hover hover:text-ink"
				onClick={() => setOpen((v) => !v)}
			>
				{trigger}
				<ChevronDownIcon />
			</button>
			{open && (
				<div className="absolute bottom-full left-1/2 z-30 mb-1 max-h-64 w-56 -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg">
					{children(() => setOpen(false))}
				</div>
			)}
		</div>
	);
}
