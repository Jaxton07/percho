import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { CheckIcon, ChevronDownIcon } from "../icons";

/** pi 支持的思考深度（顺序即显示顺序） */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function levelLabel(t: ReturnType<typeof useT>, level: string): string {
	return t(`thinkingLevels.${isThinkingLevel(level) ? level : "medium"}`);
}

/** 输入框思考深度切换：chip 按钮 + 上弹单选列表 */
export function ThinkingPicker() {
	const t = useT();
	const thinkingLevel = useSessionsStore((s) => s.thinkingLevel);
	const setThinkingLevel = useSessionsStore((s) => s.setThinkingLevel);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const label = levelLabel(t, thinkingLevel);

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				title={t("composer.thinkingSwitch")}
				className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800"
				onClick={() => setOpen((v) => !v)}
			>
				<span>{label}</span>
				<ChevronDownIcon className={open ? "rotate-180 transition-transform" : "transition-transform"} />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-30 mb-1 w-40 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-lg">
					{THINKING_LEVELS.map((level) => {
						const selected = level === thinkingLevel;
						return (
							<button
								key={level}
								type="button"
								className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
									selected ? "text-blue-600" : "text-zinc-700 hover:bg-zinc-100"
								}`}
								onClick={() => {
									void setThinkingLevel(level);
									setOpen(false);
								}}
							>
								<span>{levelLabel(t, level)}</span>
								{selected && <CheckIcon size={12} />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
