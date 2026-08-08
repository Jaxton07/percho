import type { Language } from "../../i18n";
import { useI18nStore, useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";

/** 通用设置面板：语言选择 + 内置权限门控开关 */
export function GeneralPanel() {
	const t = useT();
	const language = useI18nStore((s) => s.language);
	const setLanguage = useI18nStore((s) => s.setLanguage);
	const permissionEnabled = useSettingsStore((s) => s.permissionEnabled);
	const setPermissionEnabled = useSettingsStore((s) => s.setPermissionEnabled);

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h3 className="text-[13px] font-medium text-zinc-800">{t("settings.language")}</h3>
				<p className="mt-0.5 text-[11px] text-zinc-400">{t("settings.languageHint")}</p>
				<div className="mt-2 flex gap-2">
					{(["zh", "en"] as Language[]).map((lang) => (
						<button
							key={lang}
							type="button"
							className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
								language === lang
									? "border-zinc-900 bg-zinc-900 text-white"
									: "border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50"
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
					<h3 className="text-[13px] font-medium text-zinc-800">{t("settings.permissionGate")}</h3>
					<button
						type="button"
						role="switch"
						aria-checked={permissionEnabled === true}
						disabled={permissionEnabled === null}
						onClick={() => void setPermissionEnabled(!(permissionEnabled === true))}
						className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
							permissionEnabled === true ? "bg-zinc-900" : "bg-zinc-300"
						} disabled:opacity-40`}
					>
						<span
							className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
								permissionEnabled === true ? "left-[18px]" : "left-0.5"
							}`}
						/>
					</button>
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">{t("settings.permissionGateHint")}</p>
			</div>
		</div>
	);
}
