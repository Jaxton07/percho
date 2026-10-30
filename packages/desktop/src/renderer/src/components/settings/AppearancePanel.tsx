import { CODE_FONT_SIZE_PRESETS, formatFontSize, type ThemeMode, UI_FONT_SIZE_PRESETS } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../i18n";
import { backgroundImageUrl, useThemeStore } from "../../stores/theme";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { ChevronDownIcon, MonitorIcon, MoonIcon, SunIcon } from "../icons";
import { SelectionMenu } from "../ui/SelectionMenu";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { UiPluginsSection } from "./UiPluginsSection";

/** 档位名（四个档位通用）：小 / 默认 / 大 / 更大 —— 与档位数组下标一一对应 */
const PRESET_LABEL_KEYS = [
	"settings.fontSizePreset12",
	"settings.fontSizePresetDefault",
	"settings.fontSizePresetLarge",
	"settings.fontSizePresetLarger",
] as const;

/** 数值触发器 + 档位列表；复用带键盘导航、视口定位的设置选择菜单。 */
function FontSizeSelect({
	label,
	presets,
	value,
	onChange,
}: {
	label: string;
	presets: readonly number[];
	value: number;
	onChange: (px: number) => void;
}) {
	const t = useT();
	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const options = presets.map((px, index) => ({
		value: String(px),
		label: `${t(PRESET_LABEL_KEYS[index] ?? "settings.fontSizePresetDefault")} · ${formatFontSize(px)}`,
	}));
	if (!presets.includes(value)) options.push({ value: String(value), label: formatFontSize(value) });
	return (
		<>
			<button
				type="button"
				aria-label={`${label}: ${formatFontSize(value)}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				className="flex shrink-0 items-center justify-end gap-2 rounded-lg bg-transparent px-2 py-1.5 text-ui-12 text-ink outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink-faint"
				onClick={(event) => {
					setAnchor(event.currentTarget);
					setOpen((value) => !value);
				}}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						setAnchor(event.currentTarget);
						setOpen(true);
					}
				}}
			>
				<span className="tabular-nums">{value}</span>
				<span className="text-ink-dim">px</span>
				<ChevronDownIcon
					size={12}
					className={`shrink-0 text-ink-dim transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{anchor && (
				<SelectionMenu
					anchor={anchor}
					open={open}
					label={label}
					options={options}
					value={String(value)}
					onSelect={(next) => onChange(Number(next))}
					onClose={() => setOpen(false)}
					onExited={() => setAnchor(null)}
				/>
			)}
		</>
	);
}

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];
const THEME_LABEL_KEYS = {
	light: "settings.themeLight",
	dark: "settings.themeDark",
	system: "settings.themeSystem",
} as const;
const THEME_ICONS = { light: SunIcon, dark: MoonIcon, system: MonitorIcon };

type AppearanceTab = "basics" | "uiPlugins";

const APPEARANCE_TABS = [
	{ id: "basics", labelKey: "settings.appearance.tabBasics" },
	{ id: "uiPlugins", labelKey: "settings.appearance.tabUiPlugins" },
] as const;

/** 基础子页：主题模式 + 自定义背景图（选图/清除/遮罩浓度）+ 显示顶栏 + 中央动画 */
function AppearanceBasics() {
	const t = useT();
	const mode = useThemeStore((s) => s.mode);
	const setMode = useThemeStore((s) => s.setMode);
	const background = useThemeStore((s) => s.background);
	const pickBackground = useThemeStore((s) => s.pickBackground);
	const clearBackground = useThemeStore((s) => s.clearBackground);
	const setBackgroundDim = useThemeStore((s) => s.setBackgroundDim);
	const barSessionsVisible = useUiPreferencesStore((s) => s.barSessionsVisible);
	const setBarSessionsVisible = useUiPreferencesStore((s) => s.setBarSessionsVisible);
	const sessionRailEnabled = useUiPreferencesStore((s) => s.sessionRailEnabled);
	const setSessionRailEnabled = useUiPreferencesStore((s) => s.setSessionRailEnabled);
	const centerOrbEnabled = useUiPreferencesStore((s) => s.centerOrbEnabled);
	const setCenterOrbEnabled = useUiPreferencesStore((s) => s.setCenterOrbEnabled);
	const uiFontSize = useUiPreferencesStore((s) => s.uiFontSize);
	const setUiFontSize = useUiPreferencesStore((s) => s.setUiFontSize);
	const codeFontSize = useUiPreferencesStore((s) => s.codeFontSize);
	const setCodeFontSize = useUiPreferencesStore((s) => s.setCodeFontSize);

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h3 className="text-ui-13 font-medium text-ink">{t("settings.theme")}</h3>
				<p className="mt-0.5 text-ui-11 text-ink-faint">{t("settings.themeHint")}</p>
				<fieldset className="mt-3 grid min-w-0 grid-cols-3 gap-2" aria-label={t("settings.theme")}>
					{THEME_MODES.map((m) => {
						const Icon = THEME_ICONS[m];
						return (
							<button
								key={m}
								type="button"
								aria-pressed={mode === m}
								className={`flex min-h-22 min-w-0 flex-col items-center justify-center gap-2 rounded-xl border px-2 py-4 text-ui-13 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ink-faint ${
									mode === m
										? "border-ink-faint bg-hover text-ink"
										: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
								}`}
								onClick={() => setMode(m)}
							>
								<Icon size={20} />
								{t(THEME_LABEL_KEYS[m])}
							</button>
						);
					})}
				</fieldset>
			</div>
			<div>
				<h3 className="text-ui-13 font-medium text-ink">{t("settings.fontSize")}</h3>
				<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">{t("settings.fontSizeHint")}</p>
				<div className="mt-3 flex items-center justify-between gap-4">
					<span className="text-ui-13 text-ink-2">{t("settings.fontSizeUi")}</span>
					<FontSizeSelect
						label={t("settings.fontSizeUi")}
						presets={UI_FONT_SIZE_PRESETS}
						value={uiFontSize}
						onChange={setUiFontSize}
					/>
				</div>
				<div className="mt-3 flex items-center justify-between gap-4">
					<span className="text-ui-13 text-ink-2">{t("settings.fontSizeCode")}</span>
					<FontSizeSelect
						label={t("settings.fontSizeCode")}
						presets={CODE_FONT_SIZE_PRESETS}
						value={codeFontSize}
						onChange={setCodeFontSize}
					/>
				</div>
			</div>
			<div>
				<h3 className="text-ui-13 font-medium text-ink">{t("settings.background")}</h3>
				<p className="mt-0.5 text-ui-11 text-ink-faint">{t("settings.backgroundHint")}</p>
				<div className="mt-2 flex items-center gap-3">
					{background.image ? (
						<img
							src={backgroundImageUrl(background.image)}
							alt=""
							className="h-16 w-28 rounded-lg border border-border object-cover"
						/>
					) : (
						<div className="flex h-16 w-28 items-center justify-center rounded-lg border border-dashed border-border text-ui-11 text-ink-faint">
							—
						</div>
					)}
					<div className="flex gap-2">
						<button
							type="button"
							className="rounded-lg border border-border px-3 py-1.5 text-ui-13 text-ink-2 transition-colors hover:border-border-strong hover:bg-hover"
							onClick={() => void pickBackground()}
						>
							{t(background.image ? "settings.backgroundChange" : "settings.backgroundPick")}
						</button>
						{background.image && (
							<button
								type="button"
								className="rounded-lg px-3 py-1.5 text-ui-13 text-red-500 transition-colors hover:bg-red-50"
								onClick={clearBackground}
							>
								{t("settings.backgroundClear")}
							</button>
						)}
					</div>
				</div>
				{background.image && (
					<div className="mt-3 flex items-center gap-3">
						<span className="w-20 shrink-0 text-ui-12 text-ink-dim">{t("settings.backgroundDim")}</span>
						<input
							type="range"
							min={20}
							max={100}
							value={Math.round(background.dim * 100)}
							onChange={(e) => setBackgroundDim(Number(e.target.value) / 100)}
							className="h-1 flex-1 accent-[#7c3aed]"
							aria-label={t("settings.backgroundDim")}
						/>
						<span className="w-10 shrink-0 text-right text-ui-12 tabular-nums text-ink-dim">
							{Math.round(background.dim * 100)}%
						</span>
					</div>
				)}
			</div>
			<SettingsSwitchRow
				title={t("settings.topBar")}
				hint={t("settings.topBarHint")}
				checked={barSessionsVisible}
				onCheckedChange={setBarSessionsVisible}
			/>
			<SettingsSwitchRow
				title={t("settings.sessionRail")}
				hint={t("settings.sessionRailHint")}
				checked={sessionRailEnabled}
				onCheckedChange={setSessionRailEnabled}
			/>
			<SettingsSwitchRow
				title={t("settings.centerOrb")}
				hint={t("settings.centerOrbHint")}
				checked={centerOrbEnabled}
				onCheckedChange={setCenterOrbEnabled}
			/>
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
			<div className="flex w-fit gap-5 border-b border-border px-0.5 pt-0.5">
				{APPEARANCE_TABS.map((tabDef) => (
					<button
						key={tabDef.id}
						type="button"
						className={`relative -mb-px border-b-2 px-0.5 pb-[9px] pt-[5px] text-ui-13 transition-colors ${
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
