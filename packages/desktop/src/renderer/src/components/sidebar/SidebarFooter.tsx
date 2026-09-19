import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { DiffIcon, GearIcon } from "../icons";

/**
 * 左栏底部：只有「设置」（帮助已去掉）——左栏收起时整栏藏起，所以设置入口就只在侧栏，不另设临时图标。
 * 顶栏关闭时追加「本轮改动」（原本在顶栏右侧的 diff 开关）。
 */
export function SidebarFooter() {
	const t = useT();
	const topBarVisible = useUiPreferencesStore((s) => s.topBarVisible);
	const diffSidebarOpen = useUiStore((s) => s.diffSidebarOpen);
	const toggleDiffSidebar = useUiStore((s) => s.toggleDiffSidebar);
	const setSettingsOpen = useSettingsStore((s) => s.setOpen);
	const item = "flex h-8 w-full items-center gap-[9px] rounded-[7px] px-2 text-[13.5px] transition-colors";
	return (
		<div className="flex shrink-0 flex-col gap-px border-t border-border p-2">
			{!topBarVisible && (
				<button
					type="button"
					className={`${item} ${diffSidebarOpen ? "bg-hover text-ink" : "text-ink-dim hover:bg-hover hover:text-ink"}`}
					onClick={toggleDiffSidebar}
				>
					<DiffIcon size={14} />
					<span>{t("sidebar.diff")}</span>
				</button>
			)}
			<button
				type="button"
				className={`${item} text-ink-dim hover:bg-hover hover:text-ink`}
				onClick={() => setSettingsOpen(true)}
			>
				<GearIcon size={14} />
				<span>{t("sidebar.settings")}</span>
			</button>
		</div>
	);
}
