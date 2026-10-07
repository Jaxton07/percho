import type { AvailableModel } from "@percho/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveModelInfo, useThinkingLevelState } from "../../hooks/use-session-state";
import { useT } from "../../i18n";
import { thinkingLevelKey } from "../../lib/thinking";
import { useSessionsStore } from "../../stores/sessions";
import { CheckIcon, ChevronDownIcon, CloseIcon, SearchIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";
import { filterModelGroups, type ModelGroup } from "./model-filter";
import { ThinkingSlider } from "./ThinkingSlider";

/**
 * 列表限高护栏：弹层高 363px（搜索 33 + 列表 248 + 思考段 64 + 内距），
 * 加上顶栏 48 / 间距 4 / 输入框 ~86 / 底部 12 = 513px —— 窗口矮于它面板顶会被窗口上沿裁掉，
 * 搜索行与头部模型直接看不见（最小窗口 480px 就会踩到）。这里把列表让高，
 * 保证搜索行 + 思考条永远在视口内。
 */
const LIST_MAX_HEIGHT = "min(248px, calc(100vh - 265px))";

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
	// chip 上的档位后缀 + 底部横条共用同一份状态（clamp 只作用于显示，不回写）
	const { supported, display } = useThinkingLevelState();
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
		// 面板故意不关（设计稿定稿）：模型列表与思考条是一件事的两个面，选完往往顺手接着调档位；
		// Esc / 点弹层外关闭。
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
				className="flex max-w-[208px] items-center gap-1 rounded-full px-2.5 py-1 text-ui-12 leading-[calc(1_/_0.75)] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
				onClick={() => setOpen((v) => !v)}
			>
				{/* 模型名先截断，档位后缀永不截断（否则长模型名下看不到当前档位） */}
				<span className="truncate">{label}</span>
				<span className="shrink-0 text-ink-faint">·</span>
				<span className="shrink-0 text-ink-faint">{t(thinkingLevelKey(display))}</span>
				<ChevronDownIcon className={open ? "rotate-180 transition-transform" : "transition-transform"} />
			</button>
			{/* 右对齐（不是 left-0）：模型按钮就在 composer 右侧，288px 弹层向左展开才能留在视口内。
			    旧版 left-0 会让面板右缘越出视口约 12px（1100/900/700px 窗口实测均如此），
			    配合搜索框 autoFocus 触发 Chromium 对 #root 的程序性横向滚动（overflow:hidden 拦不住）：
			    窄窗口下实测根横滚约 35.5px，顶栏最左按钮 left 从 80 被挤到 72（1100px）/44.5（窄窗口）。 */}
			{open && (
				<div
					data-composer-overlay=""
					className="absolute right-0 bottom-full z-30 mb-1 w-72 rounded-xl bg-surface p-1 shadow-pop"
				>
					<div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 pr-3">
						<SearchIcon size={13} className="shrink-0 text-ink-faint" />
						<input
							ref={inputRef}
							// biome-ignore lint/a11y/noAutofocus: 弹层打开即聚焦搜索框（键盘用户直接输入过滤）
							autoFocus
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={onSearchKeyDown}
							placeholder={t("composer.modelSearchPlaceholder")}
							className="w-full bg-transparent text-ui-12 leading-[calc(1_/_0.75)] text-ink placeholder:text-ink-faint focus:outline-none"
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
					{/* 分隔不用实线：1px 两端淡出的渐变（搜索行下 / 列表下各一条） */}
					<div className="fade-rule mb-1" />
					{flat.length === 0 && (
						<div className="px-2 py-3 text-center text-ui-12 leading-[calc(1_/_0.75)] text-ink-faint">
							{query === "" ? t("settings.providers.empty") : t("composer.modelSearchEmpty")}
						</div>
					)}
					{/* scrollbar-gutter: stable：滚动条出现/消失时行宽不跳，且勾选图标与搜索行的清除按钮右缘对齐
					    （搜索行多了 pr-3 那 4px）；限高带矮窗口护栏，见 LIST_MAX_HEIGHT */}
					<div
						ref={listRef}
						className="thin-scrollbar max-h-64 overflow-y-auto [scrollbar-gutter:stable]"
						style={{ maxHeight: LIST_MAX_HEIGHT }}
					>
						{filtered.map((group) => (
							<div key={group.name}>
								<div className="px-2 pt-2 pb-1 text-ui-10 font-medium tracking-wide text-ink-faint uppercase">
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
											className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-ui-12 leading-[calc(1_/_0.75)] transition-colors ${
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
					<div className="fade-rule mb-1" />
					<ThinkingSlider level={display} supported={supported} />
				</div>
			)}
		</div>
	);
}
