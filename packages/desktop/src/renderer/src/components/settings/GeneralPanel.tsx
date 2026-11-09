import type { Language } from "../../i18n";
import { useI18nStore, useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { Select } from "../ui/Select";
import { CacheWarmingSettings } from "./CacheWarmingSettings";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { TaskNotificationSettings } from "./TaskNotificationSettings";

const LANGUAGES: Language[] = ["zh", "en"];

/** 通用设置面板（上下文压缩：主开关“第三方接管”+ 三个可见子层；蒸发无自有开关，接管期间自动让位） */
export function GeneralPanel() {
	const t = useT();
	const codemodeEnabled = useSettingsStore((s) => s.codemodeEnabled);
	const codemodeSaving = useSettingsStore((s) => s.codemodeSaving);
	const setCodemodeEnabled = useSettingsStore((s) => s.setCodemodeEnabled);
	const codemodeOnly = useSettingsStore((s) => s.codemodeOnly);
	const setCodemodeOnly = useSettingsStore((s) => s.setCodemodeOnly);
	const language = useI18nStore((s) => s.language);
	const setLanguage = useI18nStore((s) => s.setLanguage);
	const channelWatchEnabled = useSettingsStore((s) => s.channelWatchEnabled);
	const setChannelWatchEnabled = useSettingsStore((s) => s.setChannelWatchEnabled);
	const compressionSdkAuto = useSettingsStore((s) => s.compressionSdkAuto);
	const compressionTakeover = useSettingsStore((s) => s.compressionTakeover);
	const compressionEvaporation = useSettingsStore((s) => s.compressionEvaporation);
	const setCompressionTakeover = useSettingsStore((s) => s.setCompressionTakeover);
	const compressionGuard = useSettingsStore((s) => s.compressionGuard);
	const compressionSaving = useSettingsStore((s) => s.compressionSaving);
	const setCompressionSdkAuto = useSettingsStore((s) => s.setCompressionSdkAuto);
	const setCompressionGuard = useSettingsStore((s) => s.setCompressionGuard);

	return (
		<div className="flex flex-col gap-6">
			<TaskNotificationSettings />
			<CacheWarmingSettings />
			<SettingsSwitchRow
				title={t("settings.codemode")}
				hint={t("settings.codemodeHint")}
				checked={codemodeEnabled === true}
				disabled={codemodeEnabled === null || codemodeSaving}
				onCheckedChange={(enabled) => void setCodemodeEnabled(enabled)}
			/>
			<div>
				<SettingsSwitchRow
					title={t("settings.codemodeOnly")}
					hint={t("settings.codemodeOnlyHint")}
					checked={codemodeOnly === true}
					disabled={codemodeEnabled !== true || codemodeOnly === null || codemodeSaving}
					onCheckedChange={(only) => void setCodemodeOnly(only)}
				/>
			</div>
			<div className="flex flex-col gap-3">
				<SettingsSwitchRow
					title={t("settings.compressionTakeover")}
					hint={t("settings.compressionTakeoverHint")}
					checked={compressionTakeover === true}
					disabled={compressionTakeover === null || compressionSaving}
					onCheckedChange={(enabled) => void setCompressionTakeover(enabled)}
				/>
				{/* 子项：接管打开时子开关置灰（它们已被主开关强制关，单独改会跟主开关说谎） */}
				<div className="flex flex-col gap-3 border-l border-ink/10 pl-4">
					<SettingsSwitchRow
						title={t("settings.compressionSdk")}
						hint={t("settings.compressionSdkHint")}
						checked={compressionSdkAuto === true}
						disabled={compressionSdkAuto === null || compressionSaving || compressionTakeover === true}
						onCheckedChange={(enabled) => void setCompressionSdkAuto(enabled)}
					/>
					<SettingsSwitchRow
						title={t("settings.compressionGuard")}
						hint={t("settings.compressionGuardHint")}
						checked={compressionGuard === true}
						disabled={compressionGuard === null || compressionSaving || compressionTakeover === true}
						onCheckedChange={(enabled) => void setCompressionGuard(enabled)}
					/>
					<SettingsSwitchRow
						title={t("settings.compressionEvaporation")}
						hint={t("settings.compressionEvaporationHint")}
						checked={compressionEvaporation === true}
						disabled
						onCheckedChange={() => {}}
					/>
				</div>
			</div>
			<div>
				<div className="flex items-center justify-between gap-4">
					<div className="min-w-0">
						<h3 className="text-ui-13 font-medium text-ink">{t("settings.language")}</h3>
						<p className="mt-0.5 text-ui-11 text-ink-faint">{t("settings.languageHint")}</p>
					</div>
					<div className="shrink-0">
						<Select
							variant="ghost"
							ariaLabel={t("settings.language")}
							value={language}
							options={LANGUAGES.map((lang) => ({ value: lang, label: t(`lang.${lang}`) }))}
							onChange={(value) => setLanguage(value as Language)}
						/>
					</div>
				</div>
			</div>
			<SettingsSwitchRow
				title={t("settings.channelWatch")}
				hint={t("settings.channelWatchHint")}
				checked={channelWatchEnabled === true}
				disabled={channelWatchEnabled === null}
				onCheckedChange={(enabled) => void setChannelWatchEnabled(enabled)}
			/>
		</div>
	);
}
