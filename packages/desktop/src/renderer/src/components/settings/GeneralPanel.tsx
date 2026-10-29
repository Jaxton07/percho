import type { Language } from "../../i18n";
import { useI18nStore, useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { Select } from "../ui/Select";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { TaskNotificationSettings } from "./TaskNotificationSettings";

const LANGUAGES: Language[] = ["zh", "en"];

/** 通用设置面板：语言下拉 + channel-watch 开关（上下文蒸发为内置常开策略，不提供开关） */
export function GeneralPanel() {
	const t = useT();
	const language = useI18nStore((s) => s.language);
	const setLanguage = useI18nStore((s) => s.setLanguage);
	const channelWatchEnabled = useSettingsStore((s) => s.channelWatchEnabled);
	const setChannelWatchEnabled = useSettingsStore((s) => s.setChannelWatchEnabled);

	return (
		<div className="flex flex-col gap-6">
			<TaskNotificationSettings />
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
