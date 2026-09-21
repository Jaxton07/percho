import { useT } from "../../i18n";
import { COMPOSER_FOCUS_EVENT } from "../../stores/drafts";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { EditIcon, SearchIcon } from "../icons";

/**
 * 左栏固定头区：新会话入口 + 搜索框。它位于会话列表滚动容器之外，因此列表滚动时始终常驻。
 * 顶部入口与顶栏「＋」同语义：从真实会话进入时复用当前项目/模型等配置；已在 draft 页则原样保留。
 */
export function SidebarHeader() {
	const t = useT();
	const search = useProjectsStore((s) => s.search);
	const setSearch = useProjectsStore((s) => s.setSearch);
	const activateNewSessionDraft = useSessionsStore((s) => s.activateNewSessionDraft);

	const openNewSession = () => {
		activateNewSessionDraft();
		// 等新会话页 Composer 挂载后再聚焦；同步派发会被刚卸载的真实会话 Composer 接走。
		requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT)));
	};

	return (
		<div className="flex shrink-0 flex-col gap-1 px-2.5 pt-2.5 pb-2">
			<button
				type="button"
				className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-[14px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
				onClick={openNewSession}
			>
				<EditIcon size={17} className="shrink-0" />
				<span>{t("sidebar.newSession")}</span>
			</button>
			<div className="flex h-8 min-w-0 items-center gap-1.5 rounded-lg bg-hover px-2">
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
