import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { CheckIcon, ChevronDownIcon } from "../icons";

/** 输入框模型快速切换：chip 按钮 + 向上弹出分组列表（只显示已配置 provider，参考 codex/opencode） */
export function ModelPicker() {
	const t = useT();
	const models = useSessionsStore((s) => s.models);
	const currentModel = useSessionsStore((s) => s.currentModel);
	const setCurrentModel = useSessionsStore((s) => s.setCurrentModel);
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

	const current = useMemo(
		() =>
			currentModel
				? (models.find((m) => m.provider === currentModel.provider && m.id === currentModel.modelId) ?? null)
				: null,
		[models, currentModel],
	);

	const groups = useMemo(() => {
		const map = new Map<string, { name: string; items: typeof models }>();
		for (const m of models) {
			const group = map.get(m.provider);
			if (group) {
				group.items.push(m);
			} else {
				map.set(m.provider, { name: m.providerName || m.provider, items: [m] });
			}
		}
		return Array.from(map.values());
	}, [models]);

	const label =
		current?.label ??
		(currentModel ? `${currentModel.provider}/${currentModel.modelId}` : t("composer.modelDefault"));

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				title={t("composer.modelSwitch")}
				className="flex max-w-[160px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink-dim transition-colors hover:bg-hover hover:text-ink"
				onClick={() => setOpen((v) => !v)}
			>
				<span className="truncate">{label}</span>
				<ChevronDownIcon className={open ? "rotate-180 transition-transform" : "transition-transform"} />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg">
					{groups.length === 0 && (
						<div className="px-2 py-3 text-center text-xs text-ink-faint">
							{t("settings.providers.empty")}
						</div>
					)}
					{groups.map((group) => (
						<div key={group.name}>
							<div className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-ink-faint uppercase">
								{group.name}
							</div>
							{group.items.map((m) => {
								const selected = currentModel?.provider === m.provider && currentModel.modelId === m.id;
								return (
									<button
										key={`${m.provider}/${m.id}`}
										type="button"
										className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
											selected ? "text-blue-600" : "text-ink-2 hover:bg-hover"
										}`}
										onClick={() => {
											void setCurrentModel(m.provider, m.id);
											setOpen(false);
										}}
									>
										<span className="truncate">{m.label}</span>
										{selected && <CheckIcon size={12} />}
									</button>
								);
							})}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
