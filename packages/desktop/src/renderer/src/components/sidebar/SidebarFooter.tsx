import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { GearIcon } from "../icons";

/**
 * 左栏底部：只有「设置」（帮助已去掉）——左栏收起时整栏藏起，所以设置入口就只在侧栏，不另设临时图标。
 * v9：顶栏常驻，「本轮改动」开关永远在顶栏右侧，左栏不再补这个入口。
 */
export function SidebarFooter() {
	const t = useT();
	const setSettingsOpen = useSettingsStore((s) => s.setOpen);
	return (
		<div className="flex shrink-0 flex-col gap-px border-t border-border p-2">
			<button
				type="button"
				className="flex h-8 w-full items-center gap-[9px] rounded-[7px] px-2 text-[13.5px] text-ink-dim transition-colors hover:bg-hover hover:text-ink"
				onClick={() => setSettingsOpen(true)}
			>
				<GearIcon size={14} />
				<span>{t("sidebar.settings")}</span>
			</button>
		</div>
	);
}
