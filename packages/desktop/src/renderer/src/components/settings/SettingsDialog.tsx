import { type EnvironmentRef, environmentEntityRef, environmentKey, LOCAL_ENVIRONMENT } from "@percho/shared";
import type { ComponentType, CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EnvironmentContext } from "../../environment-context";
import { getEnvironments } from "../../environment-registry";
import { useT } from "../../i18n";
import { useEdgeFade } from "../../lib/use-edge-fade";
import { PluginBoundary } from "../../plugins/PluginBoundary";
import { EMPTY_CONTRIBUTIONS } from "../../plugins/RegionHost";
import { type Contribution, useUiPluginRegistry } from "../../plugins/registry";
import { UI_REGIONS } from "../../plugins/slots";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { useSessionsStore } from "../../stores/sessions";
import {
	getSettingsStore,
	type SettingsCategory,
	useLocalSettingsStore as useSettingsStore,
} from "../../stores/settings";
import { useUiPluginsStore } from "../../stores/ui-plugins";
import { ChevronDownIcon, PuzzleIcon } from "../icons";
import { SettingsIcon } from "../icons/SettingsIcon";
import "./settings-dialog.css";
import { RemoteConnectionPanel } from "../remote/RemoteConnectionDialog";
import { SelectionMenu } from "../ui/SelectionMenu";
import { AboutPanel } from "./AboutPanel";
import { AppearancePanel } from "./AppearancePanel";
import { ArchivedChatsPanel } from "./ArchivedChatsPanel";
import { ExtensionsPanel } from "./extensions/ExtensionsPanel";
import { GeneralPanel } from "./GeneralPanel";
import { LanObserverPanel } from "./LanObserverPanel";
import { McpPanel } from "./mcp/McpPanel";
import { ProvidersPanel } from "./providers/ProvidersPanel";
import { SkillsPanel } from "./SkillsPanel";

const STATIC_CATEGORIES = [
	"general",
	"appearance",
	"archived",
	"models",
	"skills",
	"mcp",
	"extensions",
	"remote",
	"lan",
	"about",
] as const satisfies readonly SettingsCategory[];

const CATEGORY_ICONS = {
	general: "gear",
	appearance: "sun",
	archived: "archive",
	models: "sliders",
	skills: "file",
	mcp: "plug",
	extensions: "package",
	remote: "server",
	lan: "devices",
	about: "info",
} as const;

/** 面板注册表：新增分类 = 写一个面板组件 + 在这里登记（未登记显示 coming soon） */
const PANELS: Partial<Record<SettingsCategory, ComponentType>> = {
	general: GeneralPanel,
	appearance: AppearancePanel,
	archived: ArchivedChatsPanel,
	models: ProvidersPanel,
	skills: SkillsPanel,
	mcp: McpPanel,
	extensions: ExtensionsPanel,
	remote: RemoteConnectionPanel,
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

/** 设置弹窗：只在打开时挂载（弹窗体里的滚动容器需要在挂载时就能拿到 ref —— useEdgeFade 不会因
    元素后出现而重跑） */
export function SettingsDialog() {
	const open = useSettingsStore((s) => s.open);
	if (!open) return null;
	return <SettingsEnvironment />;
}

function SettingsEnvironment() {
	const [environment, setEnvironment] = useState<EnvironmentRef>(() => {
		const state = useSessionsStore.getState();
		return state.activeSessionId
			? environmentEntityRef(state.activeSessionId).environment
			: (state.newSessionDraft?.environment ?? LOCAL_ENVIRONMENT);
	});
	const category = useSettingsStore((state) => state.category);
	const key = environmentKey(environment);
	useEffect(() => {
		if (environment.kind !== "local" && category !== "remote")
			getSettingsStore(environment).getState().openWith(category);
	}, [environment, category]);
	return (
		<EnvironmentContext.Provider value={environment}>
			<SettingsDialogBody key={key} environment={environment} onEnvironmentChange={setEnvironment} />
		</EnvironmentContext.Provider>
	);
}

/** 弹窗体：左侧分类导航 + 右侧内容，两列均可独立滚动；plugin 分类由 registry 动态拼接 */
function SettingsDialogBody({
	environment,
	onEnvironmentChange,
}: {
	environment: EnvironmentRef;
	onEnvironmentChange: (environment: EnvironmentRef) => void;
}) {
	const t = useT();
	const [environmentAnchor, setEnvironmentAnchor] = useState<HTMLElement | null>(null);
	const catalog = useRemoteConnectionStore((state) => state.catalog);
	const environmentLabel = (ref: EnvironmentRef) => {
		if (ref.kind === "local") return t("settings.localEnvironment");
		return (
			catalog?.records.find(
				(record) =>
					record.connectionId === ref.connectionId && record.binding?.environmentId === ref.environmentId,
			)?.alias ?? t("remote.unavailableEnvironment")
		);
	};
	const registeredEnvironments = getEnvironments();
	const environments = registeredEnvironments.some(
		(ref) => environmentKey(ref) === environmentKey(environment),
	)
		? registeredEnvironments
		: [...registeredEnvironments, environment];
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

	// 两列各自是滚动容器：分割线只留左导航右缘那条（`.fade-rule-v`），内容区的边界改由滚动淡出表达
	const navRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	useEdgeFade(navRef);
	useEdgeFade(contentRef);

	const Panel = PANELS[category];
	const staticCategory = STATIC_CATEGORIES.find((id) => id === category);
	const dialogRef = useRef<HTMLDivElement>(null);
	const environmentAnchorRef = useRef(environmentAnchor);
	environmentAnchorRef.current = environmentAnchor;
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const dialog = dialogRef.current;
		dialog?.querySelector<HTMLButtonElement>('button[aria-current="page"]')?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (!dialog || event.defaultPrevented) return;
			const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
			if (dialogs[dialogs.length - 1] !== dialog) return;
			if (event.key === "Escape") {
				if (environmentAnchorRef.current) return;
				event.preventDefault();
				setOpen(false);
			} else if (event.key === "Tab" && dialog.contains(document.activeElement)) {
				const items = [
					...dialog.querySelectorAll<HTMLElement>(
						'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
					),
				].filter((item) => item.getClientRects().length > 0);
				if (!items.length) return;
				const first = items[0];
				const last = items[items.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last?.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first?.focus();
				}
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			previous?.focus();
		};
	}, [setOpen]);

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20">
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label={t("settings.title")}
				className="settings-dialog relative flex flex-col overflow-hidden bg-surface shadow-dialog"
			>
				{/* 顶栏底边不画 1px 实线（与对话页顶栏同一决策）：下面的内容滚动时用边界淡出区分 */}
				<div className="settings-dialog-toolbar">
					<div>
						{category !== "remote" && (
							<>
								<button
									type="button"
									className="ml-3 inline-flex max-w-[240px] items-center gap-3 rounded-full border border-border bg-transparent px-2.5 py-1 text-ui-12 font-normal text-ink-dim outline-none transition-colors hover:bg-hover focus-visible:border-ink-faint"
									aria-label={t("settings.environment")}
									aria-haspopup="listbox"
									aria-expanded={!!environmentAnchor}
									onClick={(event) => setEnvironmentAnchor(environmentAnchor ? null : event.currentTarget)}
									onKeyDown={(event) => {
										if (event.key === "ArrowDown" || event.key === "ArrowUp") {
											event.preventDefault();
											setEnvironmentAnchor(event.currentTarget);
										}
									}}
								>
									<span className="truncate">{environmentLabel(environment)}</span>
									<ChevronDownIcon size={12} className="shrink-0" />
								</button>
								{environmentAnchor && (
									<SelectionMenu
										anchor={environmentAnchor}
										label={t("settings.environment")}
										value={environmentKey(environment)}
										options={environments.map((ref) => ({
											value: environmentKey(ref),
											label: environmentLabel(ref),
										}))}
										onSelect={(value) => {
											const next = environments.find((ref) => environmentKey(ref) === value);
											if (next) onEnvironmentChange(next);
										}}
										onClose={() => setEnvironmentAnchor(null)}
									/>
								)}
							</>
						)}
					</div>
					<button
						type="button"
						className="settings-dialog-close flex items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-hover hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-ink-faint"
						onClick={() => setOpen(false)}
						aria-label={t("common.close")}
					>
						<SettingsIcon name="close" />
					</button>
				</div>
				<div className="flex min-h-0 flex-1">
					{/* 与内容的分界：中段实、两头淡出的发丝线（`.fade-rule-v`，同左栏） */}
					<nav
						ref={navRef}
						className="settings-dialog-nav fade-rule-v edge-fade shrink-0 overflow-y-auto"
						style={{ "--edge-fade-size": "16px" } as CSSProperties}
					>
						<h2 className="settings-dialog-heading text-ui-16 font-semibold text-ink">
							{t("settings.title")}
						</h2>
						{STATIC_CATEGORIES.map((id) => {
							return (
								<button
									key={id}
									type="button"
									aria-current={category === id ? "page" : undefined}
									className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-13 transition-colors ${
										category === id
											? "bg-hover font-medium text-ink"
											: "text-ink-dim hover:bg-hover hover:text-ink"
									}`}
									onClick={() => setCategory(id)}
								>
									<span className="flex w-3.5 shrink-0 items-center justify-center">
										<SettingsIcon name={CATEGORY_ICONS[id]} />
									</span>
									<span className="min-w-0">
										{t(`settings.category.${id}`)}
										{id === "remote" && (
											<span className="ml-1 inline-block text-ui-11 font-normal text-ink-faint">
												{t("settings.experimental")}
											</span>
										)}
									</span>
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
									className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-13 transition-colors ${
										category === id
											? "bg-hover font-medium text-ink"
											: "text-ink-dim hover:bg-hover hover:text-ink"
									}`}
									onClick={() => setCategory(id)}
								>
									<span className="flex w-3.5 shrink-0 items-center justify-center">
										<PuzzleIcon size={14} />
									</span>
									<span className="truncate">{c.title ?? c.pluginName}</span>
								</button>
							);
						})}
					</nav>
					<div
						ref={contentRef}
						className="settings-dialog-content edge-fade min-w-0 flex-1 overflow-auto"
						style={{ "--edge-fade-size": "20px" } as CSSProperties}
					>
						<div
							className={
								category === "general" || category === "appearance" || category === "remote"
									? "settings-dialog-form"
									: undefined
							}
						>
							<h1 className="text-ui-28 font-semibold text-ink">
								{staticCategory
									? t(`settings.category.${staticCategory}`)
									: (activePluginContribution?.title ?? activePluginContribution?.pluginName)}
							</h1>
							<div className="settings-dialog-panel">
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
									<p className="py-8 text-center text-ui-13 text-ink-faint">{t("settings.comingSoon")}</p>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
