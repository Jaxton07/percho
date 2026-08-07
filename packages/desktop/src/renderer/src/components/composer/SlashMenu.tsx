import type { SlashCommandInfo } from "@pi-desktop/shared";
import { useEffect, useRef } from "react";
import { useT } from "../../i18n";

export const SOURCE_ORDER: SlashCommandInfo["source"][] = ["builtin", "template", "skill", "extension"];

/** 过滤后的命令列表（按来源分组顺序拍平） */
export function filterCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
	return commands.filter((c) => c.name.startsWith(query));
}

/** 斜杠命令补全面板：纯展示，分组（内置/模板/skill/扩展），受控选中与回调由 Composer 驱动 */
export function SlashMenu({
	commands,
	query,
	selectedIndex,
	onSelectedIndexChange,
	onPick,
}: {
	commands: SlashCommandInfo[];
	query: string;
	/** 当前选中项在过滤后列表中的下标 */
	selectedIndex: number;
	onSelectedIndexChange: (index: number) => void;
	onPick: (command: SlashCommandInfo) => void;
}) {
	const t = useT();
	const listRef = useRef<HTMLDivElement>(null);
	const filtered = filterCommands(commands, query);
	const groups = SOURCE_ORDER.map((source) => ({
		source,
		items: filtered.filter((c) => c.source === source),
	})).filter((g) => g.items.length > 0);
	const flat = groups.flatMap((g) => g.items);
	const active = Math.min(selectedIndex, Math.max(flat.length - 1, 0));

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

	if (flat.length === 0) {
		return (
			<div className="mb-1.5 rounded-lg border border-zinc-200 bg-white py-2 text-center text-xs text-zinc-400 shadow-lg">
				{t("slash.noMatch")}
			</div>
		);
	}

	return (
		<div
			ref={listRef}
			className="mb-1.5 max-h-64 overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-lg"
		>
			{groups.map((group) => (
				<div key={group.source}>
					<p className="px-3 pt-2 pb-1 text-[11px] font-medium text-zinc-400">
						{t(`slash.group.${group.source}`)}
					</p>
					{group.items.map((command) => {
						const index = flat.indexOf(command);
						const unsupported = !command.supported;
						return (
							<button
								key={`${command.source}:${command.name}`}
								type="button"
								data-index={index}
								className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
									index === active ? "bg-zinc-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-50"
								} ${unsupported ? "cursor-not-allowed opacity-50" : ""}`}
								onMouseEnter={() => onSelectedIndexChange(index)}
								onClick={() => onPick(command)}
							>
								<span className="font-mono text-zinc-500">/{command.name}</span>
								<span className="min-w-0 flex-1 truncate text-zinc-400">{command.description}</span>
								{command.argumentHint && (
									<span className="shrink-0 font-mono text-[11px] text-zinc-300">{command.argumentHint}</span>
								)}
							</button>
						);
					})}
				</div>
			))}
		</div>
	);
}
