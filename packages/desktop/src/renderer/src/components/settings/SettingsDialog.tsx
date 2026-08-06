import type { ComponentType } from "react";
import { useState } from "react";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { GeneralPanel } from "./GeneralPanel";
import { ProvidersPanel } from "./providers/ProvidersPanel";

type SettingsCategory = "general" | "providers" | "skills" | "mcp" | "extensions";

const CATEGORIES: SettingsCategory[] = ["general", "providers", "skills", "mcp", "extensions"];

/** 面板注册表：新增分类 = 写一个面板组件 + 在这里登记（未登记显示 coming soon） */
const PANELS: Partial<Record<SettingsCategory, ComponentType>> = {
	general: GeneralPanel,
	providers: ProvidersPanel,
};

/** 设置弹窗：左侧分类导航 + 右侧内容，两列均可独立滚动 */
export function SettingsDialog() {
	const t = useT();
	const open = useSettingsStore((s) => s.open);
	const setOpen = useSettingsStore((s) => s.setOpen);
	const [category, setCategory] = useState<SettingsCategory>("providers");

	if (!open) return null;

	const Panel = PANELS[category];

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" role="dialog" aria-modal>
			<div className="flex h-[70vh] w-[720px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
				<div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-4 py-3">
					<h2 className="text-sm font-semibold text-zinc-900">{t("settings.title")}</h2>
					<button
						type="button"
						className="rounded-lg px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
						onClick={() => setOpen(false)}
						aria-label={t("common.close")}
					>
						✕
					</button>
				</div>
				<div className="flex min-h-0 flex-1">
					<nav className="w-44 shrink-0 overflow-y-auto border-r border-zinc-100 p-2">
						{CATEGORIES.map((id) => (
							<button
								key={id}
								type="button"
								className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
									category === id
										? "bg-zinc-100 font-medium text-zinc-900"
										: "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800"
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
							<p className="py-8 text-center text-[13px] text-zinc-400">{t("settings.comingSoon")}</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
