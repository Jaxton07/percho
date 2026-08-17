import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { clampThinkingLevel, THINKING_LEVELS } from "../../lib/thinking";
import { useSessionsStore } from "../../stores/sessions";
import { CheckIcon, ChevronDownIcon } from "../icons";

function isThinkingLevel(value: string): value is (typeof THINKING_LEVELS)[number] {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function levelLabel(t: ReturnType<typeof useT>, level: string): string {
	return t(`thinkingLevels.${isThinkingLevel(level) ? level : "medium"}`);
}

/** 输入框思考深度切换：chip 按钮 + 上弹单选列表（每个会话独立持有，未设置回退全局默认） */
export function ThinkingPicker() {
	const t = useT();
	const thinkingLevel = useSessionsStore((s) => s.thinkingLevel);
	const activeSession = useSessionsStore((s) => s.sessions.find((x) => x.sessionId === s.activeSessionId));
	const models = useSessionsStore((s) => s.models);
	const globalCurrentModel = useSessionsStore((s) => s.currentModel);
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

	const effective = activeSession?.thinkingLevel ?? thinkingLevel;
	// 当前会话模型实际支持的思考深度（模型配置下发）；缺省按全量显示
	const currentModelRef = activeSession?.model ?? globalCurrentModel;
	const model = models.find(
		(m) => m.provider === currentModelRef?.provider && m.id === currentModelRef?.modelId,
	);
	const supported =
		model?.thinkingLevels && model.thinkingLevels.length > 0 ? model.thinkingLevels : [...THINKING_LEVELS];
	// 当前级别超出模型能力（如切模型后遗留）→ 就近向上找，否则取 supported 最高档
	const displayLevel = clampThinkingLevel(effective, supported);
	const label = levelLabel(t, displayLevel);

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink-dim transition-colors hover:bg-hover hover:text-ink"
				onClick={() => setOpen((v) => !v)}
			>
				<span>{label}</span>
				<ChevronDownIcon className={open ? "rotate-180 transition-transform" : "transition-transform"} />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-30 mb-1 w-40 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop">
					{THINKING_LEVELS.filter((level) => (supported as readonly string[]).includes(level)).map(
						(level) => {
							const selected = level === displayLevel;
							return (
								<button
									key={level}
									type="button"
									className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
										selected ? "text-blue-600" : "text-ink-2 hover:bg-hover"
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
						},
					)}
				</div>
			)}
		</div>
	);
}
