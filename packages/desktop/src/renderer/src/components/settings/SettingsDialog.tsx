import type { ComponentType } from "react";
import { useMemo } from "react";
import { useT } from "../../i18n";
import { PluginBoundary } from "../../plugins/PluginBoundary";
import { EMPTY_CONTRIBUTIONS } from "../../plugins/RegionHost";
import { type Contribution, useUiPluginRegistry } from "../../plugins/registry";
import { UI_REGIONS } from "../../plugins/slots";
import { type SettingsCategory, useSettingsStore } from "../../stores/settings";
import { useUiPluginsStore } from "../../stores/ui-plugins";
import { AboutPanel } from "./AboutPanel";
import { AppearancePanel } from "./AppearancePanel";
import { ExtensionsPanel } from "./extensions/ExtensionsPanel";
import { GeneralPanel } from "./GeneralPanel";
import { LanObserverPanel } from "./LanObserverPanel";
import { McpPanel } from "./McpPanel";
import { ProvidersPanel } from "./providers/ProvidersPanel";
import { SkillsPanel } from "./SkillsPanel";
import { UiPluginsPanel } from "./UiPluginsPanel";
import { VisionPanel } from "./VisionPanel";

const STATIC_CATEGORIES = [
	"general",
	"appearance",
	"models",
	"skills",
	"mcp",
	"extensions",
	"uiPlugins",
	"vision",
	"lan",
	"about",
] as const satisfies readonly SettingsCategory[];

/** 面板注册表：新增分类 = 写一个面板组件 + 在这里登记（未登记显示 coming soon） */
const PANELS: Partial<Record<SettingsCategory, ComponentType>> = {
	general: GeneralPanel,
	appearance: AppearancePanel,
	models: ProvidersPanel,
	skills: SkillsPanel,
	mcp: McpPanel,
	extensions: ExtensionsPanel,
	uiPlugins: UiPluginsPanel,
	vision: VisionPanel,
	lan: LanObserverPanel,
	about: AboutPanel,
};

/** settings.panel 贡献的分类 id：plugin:<pluginName>:<contributionId>（spec §17） */
function pluginCategoryId(pluginName: string, contributionId: string): SettingsCategory {
	return `plugin:${pluginName}:${contributionId}`;
}

/** 由分类 id 反查 settings.panel 贡献；非 plugin: 前缀或已不存在返回 null */
function findPluginContribution(category: SettingsCategory, list: Contribution[] | undefined) {
	if (!category.startsWith("plugin:")) return null;
	const rest = category.slice("plugin:".length);
	const sep = rest.indexOf(":");
	if (sep < 0) return null;
	const pluginName = rest.slice(0, sep);
	const contributionId = rest.slice(sep + 1);
	return list?.find((c) => c.pluginName === pluginName && c.id === contributionId) ?? null;
}

/** 设置弹窗：左侧分类导航 + 右侧内容，两列均可独立滚动；plugin 分类由 registry 动态拼接 */
export function SettingsDialog() {
	const t = useT();
	const open = useSettingsStore((s) => s.open);
	const setOpen = useSettingsStore((s) => s.setOpen);
	const category = useSettingsStore((s) => s.category);
	const setCategory = useSettingsStore((s) => s.setCategory);

	// settings.panel 贡献：动态分类（插件停用/卸载即消失）；稳定引用（空用模块级 EMPTY）
	// 全局总开关关闭时隐藏插件分类（与 RegionHost 同一开关语义；当前正在看的分类回落 comingSoon 空态）
	const masterOn = useUiPluginsStore((s) => s.config.enabled);
	const registryCategories = useUiPluginRegistry((s) => s.contributions[UI_REGIONS.SettingsPanel]);
	const pluginCategories = masterOn ? (registryCategories ?? EMPTY_CONTRIBUTIONS) : EMPTY_CONTRIBUTIONS;
	// 贡献边界 key 带 loadNonce（与 RegionHost 一致）：热重载换新边界实例，settings.panel 贡献崩溃后可恢复
	const pluginNonces = useUiPluginRegistry((s) => s.loadNonces);

	const activePluginContribution = useMemo(
		() => findPluginContribution(category, pluginCategories),
		[category, pluginCategories],
	);

	if (!open) return null;

	const Panel = PANELS[category];

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20" role="dialog" aria-modal>
			<div className="flex h-[70vh] w-[720px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-dialog">
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
						{STATIC_CATEGORIES.map((id) => (
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
						{/* 插件自带设置页分类：标题取 contribution.title（插件自定义字符串，不走宿主 i18n） */}
						{pluginCategories.map((c) => {
							const id = pluginCategoryId(c.pluginName, c.id);
							return (
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
									{c.title ?? c.pluginName}
								</button>
							);
						})}
					</nav>
					<div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
						{Panel ? (
							<Panel />
						) : activePluginContribution ? (
							// 插件设置页：包 PluginBoundary（崩溃 → null，与其他贡献同一套隔离语义）
							<PluginBoundary
								key={`${activePluginContribution.pluginName}:${activePluginContribution.id}:${
									pluginNonces[activePluginContribution.pluginName] ?? 0
								}`}
								pluginName={activePluginContribution.pluginName}
								label={category}
							>
								<activePluginContribution.component />
							</PluginBoundary>
						) : (
							<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.comingSoon")}</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
