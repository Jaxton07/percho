import type { ThemeMode } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../i18n";
import { backgroundImageUrl, useThemeStore } from "../../stores/theme";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { Switch } from "../ui/Switch";
import { UiPluginsSection } from "./UiPluginsSection";

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];
const THEME_LABEL_KEYS = {
	light: "settings.themeLight",
	dark: "settings.themeDark",
	system: "settings.themeSystem",
} as const;

type AppearanceTab = "basics" | "uiPlugins";

const APPEARANCE_TABS = [
	{ id: "basics", labelKey: "settings.appearance.tabBasics" },
	{ id: "uiPlugins", labelKey: "settings.appearance.tabUiPlugins" },
] as const;

/** 基础子页：主题模式 + 自定义背景图（选图/清除/遮罩浓度）+ 两个界面开关 */
function AppearanceBasics() {
	const t = useT();
	const mode = useThemeStore((s) => s.mode);
	const setMode = useThemeStore((s) => s.setMode);
	const background = useThemeStore((s) => s.background);
	const pickBackground = useThemeStore((s) => s.pickBackground);
	const clearBackground = useThemeStore((s) => s.clearBackground);
	const setBackgroundDim = useThemeStore((s) => s.setBackgroundDim);
	const sessionRailEnabled = useUiPreferencesStore((s) => s.sessionRailEnabled);
	const setSessionRailEnabled = useUiPreferencesStore((s) => s.setSessionRailEnabled);
	const centerOrbEnabled = useUiPreferencesStore((s) => s.centerOrbEnabled);
	const setCenterOrbEnabled = useUiPreferencesStore((s) => s.setCenterOrbEnabled);

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h3 className="text-[13px] font-medium text-ink">{t("settings.theme")}</h3>
				<p className="mt-0.5 text-[11px] text-ink-faint">{t("settings.themeHint")}</p>
				<div className="mt-2 flex gap-2">
					{THEME_MODES.map((m) => (
						<button
							key={m}
							type="button"
							className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
								mode === m
									? "border-ink bg-ink text-on-ink"
									: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
							}`}
							onClick={() => setMode(m)}
						>
							{t(THEME_LABEL_KEYS[m])}
						</button>
					))}
				</div>
			</div>
			<div>
				<h3 className="text-[13px] font-medium text-ink">{t("settings.background")}</h3>
				<p className="mt-0.5 text-[11px] text-ink-faint">{t("settings.backgroundHint")}</p>
				<div className="mt-2 flex items-center gap-3">
					{background.image ? (
						<img
							src={backgroundImageUrl(background.image)}
							alt=""
							className="h-16 w-28 rounded-lg border border-border object-cover"
						/>
					) : (
						<div className="flex h-16 w-28 items-center justify-center rounded-lg border border-dashed border-border text-[11px] text-ink-faint">
							—
						</div>
					)}
					<div className="flex gap-2">
						<button
							type="button"
							className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-border-strong hover:bg-hover"
							onClick={() => void pickBackground()}
						>
							{t(background.image ? "settings.backgroundChange" : "settings.backgroundPick")}
						</button>
						{background.image && (
							<button
								type="button"
								className="rounded-lg px-3 py-1.5 text-[13px] text-red-500 transition-colors hover:bg-red-50"
								onClick={clearBackground}
							>
								{t("settings.backgroundClear")}
							</button>
						)}
					</div>
				</div>
				{background.image && (
					<div className="mt-3 flex items-center gap-3">
						<span className="w-20 shrink-0 text-[12px] text-ink-dim">{t("settings.backgroundDim")}</span>
						<input
							type="range"
							min={20}
							max={100}
							value={Math.round(background.dim * 100)}
							onChange={(e) => setBackgroundDim(Number(e.target.value) / 100)}
							className="h-1 flex-1 accent-[#7c3aed]"
							aria-label={t("settings.backgroundDim")}
						/>
						<span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-ink-dim">
							{Math.round(background.dim * 100)}%
						</span>
					</div>
				)}
			</div>
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.sessionRail")}</h3>
					<Switch checked={sessionRailEnabled} onCheckedChange={setSessionRailEnabled} />
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.sessionRailHint")}</p>
			</div>
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.centerOrb")}</h3>
					<Switch checked={centerOrbEnabled} onCheckedChange={setCenterOrbEnabled} />
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.centerOrbHint")}</p>
			</div>
		</div>
	);
}

/**
 * 外观面板：顶部 Tab 分栏（设计稿 .local/design/ux/appearance-ui-plugins）
 * 「基础」= 内置外观设置；「UI 插件」= 替换内置组件的插件管理（原独立设置分类并入）。
 * Tab 是面板内临时视图（内存态），每次打开设置默认落在「基础」。
 */
export function AppearancePanel() {
	const t = useT();
	const [tab, setTab] = useState<AppearanceTab>("basics");

	return (
		<div>
			<div className="flex gap-5 border-b border-border px-0.5 pt-0.5">
				{APPEARANCE_TABS.map((tabDef) => (
					<button
						key={tabDef.id}
						type="button"
						className={`relative -mb-px border-b-2 px-0.5 pb-[9px] pt-[5px] text-[13px] transition-colors ${
							tab === tabDef.id
								? "border-ink font-medium text-ink"
								: "border-transparent text-ink-faint hover:text-ink-2"
						}`}
						onClick={() => setTab(tabDef.id)}
					>
						{t(tabDef.labelKey)}
					</button>
				))}
			</div>
			<div className="pt-5">{tab === "basics" ? <AppearanceBasics /> : <UiPluginsSection />}</div>
		</div>
	);
}
