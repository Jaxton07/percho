import { create } from "zustand";
import { en } from "./en";
import { type Messages, zh } from "./zh";

export type Language = "zh" | "en";

const STORAGE_KEY = "pi-desktop.lang";
const dictionaries: Record<Language, Messages> = { zh, en };

/** 默认跟随系统语言（仅首期支持中/英，其他按英文处理） */
function detectLanguage(): Language {
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved === "zh" || saved === "en") return saved;
	return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

interface I18nStore {
	language: Language;
	setLanguage: (language: Language) => void;
}

export const useI18nStore = create<I18nStore>((set) => ({
	language: detectLanguage(),
	setLanguage: (language) => {
		localStorage.setItem(STORAGE_KEY, language);
		set({ language });
	},
}));

type DotKeys<T, Prefix extends string = ""> = {
	[K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : DotKeys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = DotKeys<Messages>;

function resolve(messages: Messages, key: string): string {
	let node: unknown = messages;
	for (const part of key.split(".")) {
		node = (node as Record<string, unknown>)[part];
		if (node === undefined) return key;
	}
	return typeof node === "string" ? node : key;
}

export function translate(
	language: Language,
	key: MessageKey,
	params?: Record<string, string | number>,
): string {
	const template = resolve(dictionaries[language], key);
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

/** 组件内使用：const t = useT(); t("settings.title") / t("permission.queued", { count: 2 }) */
export function useT() {
	const language = useI18nStore((s) => s.language);
	return (key: MessageKey, params?: Record<string, string | number>) => translate(language, key, params);
}
