import type { UiPluginInfo } from "@percho/shared";
import type { ComponentType, CSSProperties } from "react";
import { useMemo, useRef } from "react";
import { useT } from "../../i18n";
import { useEdgeFade } from "../../lib/use-edge-fade";
import { PluginBoundary } from "../../plugins/PluginBoundary";
import { EMPTY_CONTRIBUTIONS } from "../../plugins/RegionHost";
import { type Contribution, useUiPluginRegistry } from "../../plugins/registry";
import { ShadowSurface } from "../../plugins/ShadowSurface";
import { SchemaSettingsPage } from "../../plugins/settings-schema-form";
import { UI_REGIONS } from "../../plugins/slots";
import { type SettingsCategory, useSettingsStore } from "../../stores/settings";
import { useUiPluginsStore } from "../../stores/ui-plugins";
import { AboutPanel } from "./AboutPanel";
import { AppearancePanel } from "./AppearancePanel";
import { ExtensionsPanel } from "./extensions/ExtensionsPanel";
import { GeneralPanel } from "./GeneralPanel";
import { LanObserverPanel } from "./LanObserverPanel";
import { McpPanel } from "./mcp/McpPanel";
import { ProvidersPanel } from "./providers/ProvidersPanel";
import { SkillsPanel } from "./SkillsPanel";

const STATIC_CATEGORIES = [
	"general",
	"appearance",
	"models",
	"skills",
	"mcp",
	"extensions",
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
	lan: LanObserverPanel,
	about: AboutPanel,
};

/** settings.panel 贡献的分类 id：plugin:<pluginName>:<contributionId> */
function pluginCategoryId(pluginName: string, contributionId: string): SettingsCategory {
	return `plugin:${pluginName}:${contributionId}`;
}

/** 声明式设置页的分类 id 后缀（与 settings.panel 贡献区分：后者用 plugin:<name>:<id>） */
const SETTINGS_SUFFIX = ":$settings";

/** 声明式设置页的分类 id（插件只声明 settingsSchema、没写设置页组件时用） */
function pluginSettingsCategoryId(pluginName: string): SettingsCategory {
	return `plugin:${pluginName}${SETTINGS_SUFFIX}` as SettingsCategory;
}

/** 由分类 id 反查"声明式设置页"插件；不是该形态返回 null */
function findSettingsCategory(category: SettingsCategory, plugins: UiPluginInfo[]) {
	if (!category.startsWith("plugin:") || !category.endsWith(SETTINGS_SUFFIX)) return null;
	const name = category.slice("plugin:".length, -SETTINGS_SUFFIX.length);
	if (!name || name.includes(":")) return null;
	return plugins.find((p) => p.name === name && p.settingsSchema) ?? null;
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

/** 设置弹窗：只在打开时挂载（弹窗体里的滚动容器需要在挂载时就能拿到 ref —— useEdgeFade 不会因
    元素后出现而重跑） */
export function SettingsDialog() {
	const open = useSettingsStore((s) => s.open);
	if (!open) return null;
	return <SettingsDialogBody />;
}

/** 弹窗体：左侧分类导航 + 右侧内容，两列均可独立滚动；plugin 分类由 registry 动态拼接 */
function SettingsDialogBody() {
	const t = useT();
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

	// 声明式设置页：manifest.settingsSchema 即可，不需要写组件。
	// 已经用 settings.panel 贡献自己画页面的插件不再重复列一项（贡献优先）。
	const pluginInfos = useUiPluginsStore((s) => s.plugins);
	const schemaPlugins = useMemo(() => {
		if (!masterOn) return [];
		const claimed = new Set(pluginCategories.map((c) => c.pluginName));
		return pluginInfos.filter(
			(p) =>
				p.enabled &&
				p.trusted &&
				!p.invalidReason &&
				p.settingsSchema &&
				!claimed.has(p.name) &&
				!p.contributions.some((c) => c.region === UI_REGIONS.SettingsPanel),
		);
	}, [masterOn, pluginCategories, pluginInfos]);
	const activeSchemaPlugin = useMemo(
		() => findSettingsCategory(category, schemaPlugins),
		[category, schemaPlugins],
	);
	const fullBleed = activePluginContribution?.layout === "full";

	// 两列各自是滚动容器：分割线只留左导航右缘那条（`.fade-rule-v`），内容区的边界改由滚动淡出表达
	const navRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	useEdgeFade(navRef);
	useEdgeFade(contentRef);

	const Panel = PANELS[category];

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20" role="dialog" aria-modal>
			<div className="flex h-[70vh] w-[720px] flex-col overflow-hidden rounded-xl bg-surface shadow-dialog">
				{/* 顶栏底边不画 1px 实线（与对话页顶栏同一决策）：下面的内容滚动时用边界淡出区分 */}
				<div className="flex shrink-0 items-center justify-between px-4 py-3">
					<h2 className="text-ui-14 leading-[calc(1.25_/_0.875)] font-semibold text-ink">
						{t("settings.title")}
					</h2>
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
					{/* 与内容的分界：中段实、两头淡出的发丝线（`.fade-rule-v`，同左栏） */}
					<nav
						ref={navRef}
						className="fade-rule-v edge-fade w-44 shrink-0 overflow-y-auto p-2"
						style={{ "--edge-fade-size": "16px" } as CSSProperties}
					>
						{STATIC_CATEGORIES.map((id) => (
							<button
								key={id}
								type="button"
								className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-ui-13 transition-colors ${
									category === id
										? "bg-hover font-medium text-ink"
										: "text-ink-dim hover:bg-hover hover:text-ink"
								}`}
								onClick={() => setCategory(id)}
							>
								{t(`settings.category.${id}`)}
							</button>
						))}
						{/* 声明式设置页分类：标题取插件 displayName（manifest 字符串，不走宿主 i18n） */}
						{schemaPlugins.map((p) => {
							const id = pluginSettingsCategoryId(p.name);
							return (
								<button
									key={id}
									type="button"
									className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-ui-13 transition-colors ${
										category === id
											? "bg-hover font-medium text-ink"
											: "text-ink-dim hover:bg-hover hover:text-ink"
									}`}
									onClick={() => setCategory(id)}
								>
									{p.displayName ?? p.name}
								</button>
							);
						})}
						{/* 插件自带设置页分类：标题取 contribution.title（插件自定义字符串，不走宿主 i18n） */}
						{pluginCategories.map((c) => {
							const id = pluginCategoryId(c.pluginName, c.id);
							return (
								<button
									key={id}
									type="button"
									className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-ui-13 transition-colors ${
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
					<div
						ref={contentRef}
						// layout=full：内容区不再套 padding、不再有外层滚动（插件自己管），否则默认 form
						className={`edge-fade min-w-0 flex-1 overflow-x-hidden ${
							fullBleed ? "min-h-0 overflow-hidden" : "overflow-y-auto px-4 py-3"
						}`}
						style={{ "--edge-fade-size": "20px" } as CSSProperties}
					>
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
								<ContributionBody contribution={activePluginContribution} label={category} />
							</PluginBoundary>
						) : activeSchemaPlugin?.settingsSchema ? (
							<SchemaSettingsPage
								pluginName={activeSchemaPlugin.name}
								schema={activeSchemaPlugin.settingsSchema}
								description={activeSchemaPlugin.description}
							/>
						) : (
							<p className="py-8 text-center text-ui-13 text-ink-faint">{t("settings.comingSoon")}</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * 贡献正文：isolation=shadow（perchoUi 2）时挂进 shadow root，否则按 v1 行为直接渲染。
 * 单独抽出来是为了让 PluginBoundary 的 key 语义保持"按贡献实例"，而不是按隔离方式。
 */
function ContributionBody({ contribution, label }: { contribution: Contribution; label: string }) {
	const Component = contribution.component;
	if (contribution.isolation === "shadow") {
		return (
			<ShadowSurface
				pluginName={contribution.pluginName}
				label={label}
				layout={contribution.layout ?? "form"}
			>
				<Component />
			</ShadowSurface>
		);
	}
	return <Component />;
}
