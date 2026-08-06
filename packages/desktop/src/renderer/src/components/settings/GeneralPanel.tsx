import type { Language } from "../../i18n";
import { useI18nStore, useT } from "../../i18n";

/** 通用设置面板：语言选择 */
export function GeneralPanel() {
	const t = useT();
	const language = useI18nStore((s) => s.language);
	const setLanguage = useI18nStore((s) => s.setLanguage);

	return (
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
	);
}
