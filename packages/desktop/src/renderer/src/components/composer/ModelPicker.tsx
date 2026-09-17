import type { AvailableModel } from "@percho/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveModelInfo } from "../../hooks/use-session-state";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { CheckIcon, ChevronDownIcon, CloseIcon, SearchIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";
import { filterModelGroups, type ModelGroup } from "./model-filter";

/** 模型在弹层内的唯一键（provider + id；键盘高亮与 DOM 定位都用它） */
function modelKey(m: AvailableModel): string {
	return `${m.provider}/${m.id}`;
}

/** 输入框模型快速切换：chip 按钮 + 向上弹出分组列表（带搜索过滤 + ↑↓/Enter 键盘导航） */
export function ModelPicker() {
	const t = useT();
	const models = useSessionsStore((s) => s.models);
	// 每个会话独立持有模型：当前会话覆写 ?? 全局默认 → models 表解析（useActiveModelInfo 收拢点）
	const current = useActiveModelInfo() ?? null;
	const setCurrentModel = useSessionsStore((s) => s.setCurrentModel);
	const [open, setOpen] = useState(false);
	/** 搜索词（每次打开重置为空） */
	const [query, setQuery] = useState("");
	/** 键盘高亮项（null = 落在当前选中模型 / 首项） */
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// 打开时重置搜索与高亮：受控 input 复用同一节点，不清会把上次的过滤条件带进来
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActiveKey(null);
	}, [open]);

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

	const groups = useMemo<ModelGroup[]>(() => {
		const map = new Map<string, ModelGroup>();
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

	const filtered = useMemo(() => filterModelGroups(groups, query), [groups, query]);
	/** 过滤后的拍平列表：键盘导航在它上面走（跳过被过滤掉的分组） */
	const flat = useMemo(() => filtered.flatMap((g) => g.items), [filtered]);
	const currentModelKey = current ? modelKey(current) : null;
	const highlightedKey =
		activeKey && flat.some((m) => modelKey(m) === activeKey) ? activeKey : (currentModelKey ?? null);

	// 键盘移动高亮时把该项滚进视野（block: nearest，已可见则不动）
	useEffect(() => {
		if (!open || !highlightedKey) return;
		listRef.current
			?.querySelector<HTMLElement>(`[data-model-key="${highlightedKey}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [open, highlightedKey]);

	const select = (m: AvailableModel) => {
		void setCurrentModel(m.provider, m.id);
		setOpen(false);
	};

	const onSearchKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (flat.length === 0) return;
			const at = flat.findIndex((m) => modelKey(m) === highlightedKey);
			const next =
				e.key === "ArrowDown" ? (at + 1 + flat.length) % flat.length : (at <= 0 ? flat.length : at) - 1;
			const target = flat[next];
			if (target) setActiveKey(modelKey(target));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const target = flat.find((m) => modelKey(m) === highlightedKey) ?? flat[0];
			if (target) select(target);
		}
	};

	const label =
		current?.label ?? (current ? `${current.provider}/${current.id}` : t("composer.modelDefault"));

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				className="flex max-w-[160px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink-dim transition-colors hover:bg-hover hover:text-ink"
				onClick={() => setOpen((v) => !v)}
			>
				<span className="truncate">{label}</span>
				<ChevronDownIcon className={open ? "rotate-180 transition-transform" : "transition-transform"} />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-30 mb-1 w-72 rounded-xl bg-surface p-1 shadow-pop">
					<div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5">
						<SearchIcon size={13} className="shrink-0 text-ink-faint" />
						<input
							ref={inputRef}
							// biome-ignore lint/a11y/noAutofocus: 弹层打开即聚焦搜索框（键盘用户直接输入过滤）
							autoFocus
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={onSearchKeyDown}
							placeholder={t("composer.modelSearchPlaceholder")}
							className="w-full bg-transparent text-xs text-ink placeholder:text-ink-faint focus:outline-none"
						/>
						{query !== "" && (
							<Tooltip label={t("composer.modelSearchClear")}>
								<button
									type="button"
									className="shrink-0 text-ink-faint transition-colors hover:text-ink-2"
									onClick={() => {
										setQuery("");
										inputRef.current?.focus();
									}}
								>
									<CloseIcon size={12} />
								</button>
							</Tooltip>
						)}
					</div>
					{/* 搜索行与列表的 1px 细分隔线（设计稿 .picker-rule，列表内容不跟搜索行粘一起） */}
					<div className="mx-1 mb-1 h-px bg-border" />
					{flat.length === 0 && (
						<div className="px-2 py-3 text-center text-xs text-ink-faint">
							{query === "" ? t("settings.providers.empty") : t("composer.modelSearchEmpty")}
						</div>
					)}
					<div ref={listRef} className="max-h-64 overflow-y-auto">
						{filtered.map((group) => (
							<div key={group.name}>
								<div className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-ink-faint uppercase">
									{group.name}
								</div>
								{group.items.map((m) => {
									const key = modelKey(m);
									const selected = currentModelKey === key;
									const active = highlightedKey === key;
									return (
										<button
											key={key}
											type="button"
											data-model-key={key}
											className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
												selected ? "text-ink" : "text-ink-2 hover:text-ink"
											} ${active ? "bg-hover" : "hover:bg-hover"}`}
											onMouseEnter={() => setActiveKey(key)}
											onClick={() => select(m)}
										>
											<span className="truncate">{m.label}</span>
											{selected && <CheckIcon size={12} />}
										</button>
									);
								})}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
