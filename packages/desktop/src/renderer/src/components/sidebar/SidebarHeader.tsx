import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { PlusIcon, SearchIcon } from "../icons";

/**
 * 左栏头区：搜索框（绑 `projects` store 的 `search`，与派生层同一份数据，无需各自过滤）。
 * 顶栏关闭时顶部让出 44px 窗口拖拽带（macOS 红绿灯 pl-20 / Windows 按钮 pr-[140px]），并在头区补一个
 * 「＋」新建会话兜底——顶栏没了就只剩这里是新建入口（画板 D ⑥）。顶栏开合开关在阶段 3 才落地，
 * 所以这条路径的阶段 2 状态是「已接线、未真机验收」。
 */
export function SidebarHeader({ platform }: { platform: string }) {
	const t = useT();
	const search = useProjectsStore((s) => s.search);
	const setSearch = useProjectsStore((s) => s.setSearch);
	const topBarVisible = useUiPreferencesStore((s) => s.topBarVisible);
	const createDraftSession = useSessionsStore((s) => s.createDraftSession);
	const cwd = useSessionsStore((s) => s.cwd);
	const setView = useUiStore((s) => s.setView);
	const chromePadding = platform === "darwin" ? "pl-20" : platform === "win32" ? "pr-[140px]" : "";

	return (
		<>
			{!topBarVisible && (
				<div className={`drag-region flex h-11 shrink-0 items-center justify-end px-2.5 ${chromePadding}`}>
					<button
						type="button"
						className="no-drag flex h-7 w-7 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-hover hover:text-ink"
						onClick={() => {
							// 只建内存 draft tab（空 tab 重启自动消失）；发送首条消息时才真正创建后端会话
							createDraftSession();
							setView("chat");
						}}
						aria-label={cwd ? t("sidebar.newSession") : t("tabbar.pickProjectFirst")}
					>
						<PlusIcon size={18} />
					</button>
				</div>
			)}
			<div className="flex shrink-0 items-center gap-1.5 px-2.5 pt-2.5 pb-2">
				<div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-hover px-2">
					<SearchIcon size={13} className="shrink-0 text-ink-faint" />
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={t("sidebar.search")}
						className="min-w-0 flex-1 bg-transparent text-[12px] text-ink-2 outline-none placeholder:text-ink-faint [&::-webkit-search-cancel-button]:hidden"
					/>
				</div>
			</div>
		</>
	);
}
