import type { ContextManagerMode } from "@percho/shared";
import type { Language } from "../../i18n";
import { useI18nStore, useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { Switch } from "../ui/Switch";

const CONTEXT_MANAGER_MODES: ContextManagerMode[] = ["evaporation", "off"];

/** 通用设置面板：语言选择 + 内置权限门控开关 + 上下文管理二态 + channel-watch 开关 */
export function GeneralPanel() {
	const t = useT();
	const language = useI18nStore((s) => s.language);
	const setLanguage = useI18nStore((s) => s.setLanguage);
	const permissionEnabled = useSettingsStore((s) => s.permissionEnabled);
	const setPermissionEnabled = useSettingsStore((s) => s.setPermissionEnabled);
	const contextManagerMode = useSettingsStore((s) => s.contextManagerMode);
	const setContextManagerMode = useSettingsStore((s) => s.setContextManagerMode);
	const channelWatchEnabled = useSettingsStore((s) => s.channelWatchEnabled);
	const setChannelWatchEnabled = useSettingsStore((s) => s.setChannelWatchEnabled);

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h3 className="text-[13px] font-medium text-ink">{t("settings.language")}</h3>
				<p className="mt-0.5 text-[11px] text-ink-faint">{t("settings.languageHint")}</p>
				<div className="mt-2 flex gap-2">
					{(["zh", "en"] as Language[]).map((lang) => (
						<button
							key={lang}
							type="button"
							className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
								language === lang
									? "border-ink bg-ink text-on-ink"
									: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
							}`}
							onClick={() => setLanguage(lang)}
						>
							{t(`lang.${lang}`)}
						</button>
					))}
				</div>
			</div>
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.permissionGate")}</h3>
					<Switch
						checked={permissionEnabled === true}
						disabled={permissionEnabled === null}
						onCheckedChange={(enabled) => void setPermissionEnabled(enabled)}
					/>
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
					{t("settings.permissionGateHint")}
				</p>
			</div>
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.contextManager")}</h3>
					<div className="flex gap-2">
						{CONTEXT_MANAGER_MODES.map((mode) => (
							<button
								key={mode}
								type="button"
								disabled={contextManagerMode === null}
								className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors disabled:opacity-50 ${
									contextManagerMode === mode
										? "border-ink bg-ink text-on-ink"
										: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
								}`}
								onClick={() => void setContextManagerMode(mode)}
							>
								{t(`settings.contextManagerMode.${mode}`)}
							</button>
						))}
					</div>
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
					{contextManagerMode ? t(`settings.contextManagerHint.${contextManagerMode}`) : ""}
				</p>
			</div>
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.channelWatch")}</h3>
					<Switch
						checked={channelWatchEnabled === true}
						disabled={channelWatchEnabled === null}
						onCheckedChange={(enabled) => void setChannelWatchEnabled(enabled)}
					/>
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.channelWatchHint")}</p>
			</div>
		</div>
	);
}
