import type { ComponentType } from "react";
import { useT } from "../../i18n";
import { type SettingsCategory, useSettingsStore } from "../../stores/settings";
import { AppearancePanel } from "./AppearancePanel";
import { GeneralPanel } from "./GeneralPanel";
import { ProvidersPanel } from "./providers/ProvidersPanel";

const CATEGORIES: SettingsCategory[] = ["general", "appearance", "providers", "skills", "mcp", "extensions"];

/** 面板注册表：新增分类 = 写一个面板组件 + 在这里登记（未登记显示 coming soon） */
const PANELS: Partial<Record<SettingsCategory, ComponentType>> = {
	general: GeneralPanel,
	appearance: AppearancePanel,
	providers: ProvidersPanel,
};

/** 设置弹窗：左侧分类导航 + 右侧内容，两列均可独立滚动 */
export function SettingsDialog() {
	const t = useT();
	const open = useSettingsStore((s) => s.open);
	const setOpen = useSettingsStore((s) => s.setOpen);
	const category = useSettingsStore((s) => s.category);
	const setCategory = useSettingsStore((s) => s.setCategory);

	if (!open) return null;

	const Panel = PANELS[category];

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20" role="dialog" aria-modal>
			<div className="flex h-[70vh] w-[720px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
				<div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
					<h2 className="text-sm font-semibold text-ink">{t("settings.title")}</h2>
					<button
						type="button"
						className="rounded-lg px-2 py-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
						onClick={() => setOpen(false)}
						aria-label={t("common.close")}
					>
						✕
					</button>
				</div>
				<div className="flex min-h-0 flex-1">
					<nav className="w-44 shrink-0 overflow-y-auto border-r border-border p-2">
						{CATEGORIES.map((id) => (
							<button
								key={id}
								type="button"
								className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
									category === id
										? "bg-hover font-medium text-ink"
										: "text-ink-dim hover:bg-hover hover:text-ink"
								}`}
								onClick={() => setCategory(id)}
							>
								{t(`settings.category.${id}`)}
							</button>
						))}
					</nav>
					<div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
						{Panel ? (
							<Panel />
						) : (
							<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.comingSoon")}</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
