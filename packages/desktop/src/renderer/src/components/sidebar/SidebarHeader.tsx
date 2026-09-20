import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { SearchIcon } from "../icons";

/**
 * 左栏头区：搜索框（绑 `projects` store 的 `search`，与派生层同一份数据，无需各自过滤）。
 * v9：顶栏常驻，不再需要「顶栏关掉时补 44px 拖拽带 + ＋ 兜底」那套（顶栏自带拖动区与新建按钮）。
 */
export function SidebarHeader() {
	const t = useT();
	const search = useProjectsStore((s) => s.search);
	const setSearch = useProjectsStore((s) => s.setSearch);

	return (
		<div className="flex shrink-0 items-center gap-1.5 px-2.5 pt-2.5 pb-2">
			<div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-hover px-2">
				<SearchIcon size={13} className="shrink-0 text-ink-faint" />
				<input
					type="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder={t("sidebar.search")}
					className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-2 outline-none placeholder:text-ink-faint [&::-webkit-search-cancel-button]:hidden"
				/>
			</div>
		</div>
	);
}
