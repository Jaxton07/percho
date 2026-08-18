import { type Language, useI18nStore } from "../i18n";

/** 当前界面语言（插件自有文案跟随中英用；useT 只能翻宿主字典，spec §18） */
export function useLanguage(): Language {
	return useI18nStore((s) => s.language);
}
