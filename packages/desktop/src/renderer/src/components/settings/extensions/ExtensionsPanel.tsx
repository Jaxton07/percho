import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";
import { BrowseSection } from "./BrowseSection";
import { LoadedSection } from "./LoadedSection";

/** 扩展设置面板：浏览社区目录安装 + 查看已加载扩展（分段切换） */
export function ExtensionsPanel() {
	const t = useT();
	const tab = useSettingsStore((s) => s.extensionsTab);
	const setExtensionsTab = useSettingsStore((s) => s.setExtensionsTab);

	return (
		<div>
			<h3 className="text-[13px] font-medium text-ink">{t("settings.extensions.title")}</h3>
			<p className="mt-0.5 text-[11px] text-ink-faint">{t("settings.extensions.hint")}</p>
			<div className="mt-3 flex rounded-lg bg-hover p-0.5">
				{(["browse", "loaded"] as const).map((id) => (
					<button
						key={id}
						type="button"
						className={`flex-1 rounded-md px-3 py-1 text-[12px] transition-colors ${
							tab === id ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-dim hover:text-ink"
						}`}
						onClick={() => setExtensionsTab(id)}
					>
						{t(`settings.extensions.tab.${id}`)}
					</button>
				))}
			</div>
			<div className="mt-3">{tab === "browse" ? <BrowseSection /> : <LoadedSection />}</div>
		</div>
	);
}
