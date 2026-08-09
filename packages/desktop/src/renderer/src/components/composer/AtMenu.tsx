import { useEffect, useRef } from "react";
import { useT } from "../../i18n";

/** @ 文件补全面板：纯展示（已过滤列表），受控选中与回调由 Composer 驱动 */
export function AtMenu({
	files,
	selectedIndex,
	onSelectedIndexChange,
	onPick,
}: {
	files: string[];
	/** 当前选中项下标 */
	selectedIndex: number;
	onSelectedIndexChange: (index: number) => void;
	onPick: (path: string) => void;
}) {
	const t = useT();
	const listRef = useRef<HTMLDivElement>(null);
	const active = Math.min(selectedIndex, Math.max(files.length - 1, 0));

	// 选中项超出可视区域时跟随滚动（键盘上下移动/鼠标悬停均生效）
	useEffect(() => {
		const container = listRef.current;
		if (!container) return;
		const item = container.querySelector<HTMLElement>(`[data-index="${active}"]`);
		if (!item) return;
		const cRect = container.getBoundingClientRect();
		const iRect = item.getBoundingClientRect();
		if (iRect.top < cRect.top) {
			container.scrollTop -= cRect.top - iRect.top;
		} else if (iRect.bottom > cRect.bottom) {
			container.scrollTop += iRect.bottom - cRect.bottom;
		}
	}, [active]);

	if (files.length === 0) {
		return (
			<div className="mb-1.5 rounded-lg border border-border bg-surface py-2 text-center text-xs text-ink-faint shadow-pop">
				{t("at.noMatch")}
			</div>
		);
	}

	return (
		<div
			ref={listRef}
			className="mb-1.5 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface shadow-pop"
		>
			{files.map((path, index) => {
				const isDir = path.endsWith("/");
				const slash = path.lastIndexOf("/", path.length - 2);
				const base = isDir ? path.slice(slash + 1, -1) : path.slice(slash + 1);
				const dir = isDir ? path.slice(0, slash + 1) : slash === -1 ? "" : path.slice(0, slash + 1);
				return (
					<button
						key={path}
						type="button"
						data-index={index}
						className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
							index === active ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"
						}`}
						onMouseEnter={() => onSelectedIndexChange(index)}
						onClick={() => onPick(path)}
					>
						<span className="shrink-0 font-mono text-ink-faint">{isDir ? "▸" : "·"}</span>
						<span className="min-w-0 flex-1 truncate font-mono">
							<span className="text-ink-faint">{dir}</span>
							<span className="text-ink-2">{base}</span>
							{isDir && <span className="text-ink-faint">/</span>}
						</span>
					</button>
				);
			})}
		</div>
	);
}
