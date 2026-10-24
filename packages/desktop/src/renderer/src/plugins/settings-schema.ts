import type { UiPluginSettingField, UiPluginSettingValue, UiPluginText } from "@percho/shared";
import type { Language } from "../i18n";

/**
 * 声明式设置的纯逻辑（不含 React）：文案解析与"当前值"求解。
 * 单独成模块的理由是这两条规则值得单测（插件最常踩的坑都在这儿），
 * 而渲染层用 jsdom 测成本高、收益低。
 */

/** 声明式文案 → 当前语言（字符串原样返回，{zh,en} 按语言取） */
export function localizeText(text: UiPluginText | undefined, language: Language): string {
	if (text === undefined) return "";
	if (typeof text === "string") return text;
	return language === "en" ? text.en : text.zh;
}

/**
 * 取字段的当前值：已存值（类型相符才用）> schema 默认值 > 类型零值。
 *
 * 类型不符时**不静默转换**（插件改了字段类型却没升 settingsSchema.version 是常见事故），
 * 直接回落到默认值；select 的值还必须是声明过的选项，否则插件删了选项后会残留非法值。
 */
export function resolveFieldValue(
	field: UiPluginSettingField,
	stored: UiPluginSettingValue | undefined,
): UiPluginSettingValue {
	const want = field.type;
	if (stored !== undefined && stored !== null) {
		if (want === "boolean" && typeof stored === "boolean") return stored;
		if (want === "string" && typeof stored === "string") return stored;
		if (want === "number" && typeof stored === "number") return stored;
		if (want === "select" && typeof stored === "string") {
			return field.options?.some((o) => o.value === stored) ? stored : (field.default ?? "");
		}
	}
	if (field.default !== undefined) return field.default;
	if (want === "boolean") return false;
	if (want === "number") return field.min ?? 0;
	return "";
}
