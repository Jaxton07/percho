import type { UiPluginSettingsSchema, UiPluginSettingValue } from "@percho/shared";
import { Switch } from "../components/ui/Switch";
import { useLanguage } from "../hooks/use-language";
import { localizeText, resolveFieldValue } from "./settings-schema";
import { usePluginSettings } from "./use-plugin-settings";

/** 输入框样式（与 ServerEditorPage 的 input 常量一致，宿主设置页的标准写法） */
const FIELD_CLASS =
	"w-full rounded-[9px] border border-border bg-canvas px-2.5 py-1.5 text-ui-12 text-ink outline-none placeholder:text-ink-faint focus:border-ink-faint";
const LABEL_CLASS = "text-ui-13 font-medium text-ink";
const HINT_CLASS = "text-ui-11 leading-[1.45] text-ink-faint";

interface SchemaSettingsPageProps {
	pluginName: string;
	schema: UiPluginSettingsSchema;
	description?: string;
}

/**
 * 声明式设置页：按 manifest.settingsSchema 自动渲染标准设置页。
 *
 * 走宿主自己的样式（Tailwind 语义 token），因此与「设置 → 通用」这类原生面板像素级一致；
 * 插件不需要写任何样式代码，也不能把这里排乱 —— 需要特殊 UI 时改用 settings.panel 贡献。
 */
export function SchemaSettingsPage({ pluginName, schema, description }: SchemaSettingsPageProps) {
	const language = useLanguage();
	// 默认值表来自 schema：只在缺键时使用，不写盘
	const defaults: Record<string, UiPluginSettingValue> = {};
	for (const [key, field] of Object.entries(schema.fields)) {
		defaults[key] = resolveFieldValue(field, undefined);
	}
	const { values, update } = usePluginSettings<Record<string, UiPluginSettingValue>>(pluginName, defaults);

	const entries = Object.entries(schema.fields);
	if (entries.length === 0) {
		return <p className="text-ui-12 text-ink-faint">这个插件没有声明任何设置项。</p>;
	}

	return (
		<div className="flex flex-col gap-6">
			{description && <p className={HINT_CLASS}>{description}</p>}
			{entries.map(([key, field]) => {
				const value = resolveFieldValue(field, values[key]);
				const label = localizeText(field.label, language);
				const hint = localizeText(field.hint, language);
				const inputId = `${pluginName}-${key}`;
				const caption = (
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className={LABEL_CLASS}>{label}</span>
						{hint && <span className={HINT_CLASS}>{hint}</span>}
					</span>
				);
				// 需要点击标题聚焦控件的字段：标题用 <label htmlFor>，不要在外层套 <label>（a11y 规则要求显式关联）
				const fieldCaption = (
					<label htmlFor={inputId} className="flex min-w-0 flex-col gap-0.5">
						<span className={LABEL_CLASS}>{label}</span>
						{hint && <span className={HINT_CLASS}>{hint}</span>}
					</label>
				);

				if (field.type === "boolean") {
					return (
						<div key={key} className="flex items-start justify-between gap-4">
							{caption}
							<Switch
								checked={value === true}
								onCheckedChange={(checked) => update({ [key]: checked })}
								aria-label={label}
							/>
						</div>
					);
				}

				if (field.type === "select") {
					return (
						<div key={key} className="flex flex-col gap-1.5">
							{fieldCaption}
							<select
								id={inputId}
								className={FIELD_CLASS}
								value={typeof value === "string" ? value : ""}
								onChange={(e) => update({ [key]: e.target.value })}
							>
								{/* 空值占位：没有匹配选项时不让 select 静默跳到第一项 */}
								{!field.options?.some((o) => o.value === value) && <option value="">—</option>}
								{field.options?.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{localizeText(opt.label, language)}
									</option>
								))}
							</select>
						</div>
					);
				}

				if (field.type === "number") {
					return (
						<div key={key} className="flex flex-col gap-1.5">
							{fieldCaption}
							<input
								id={inputId}
								type="number"
								className={FIELD_CLASS}
								value={typeof value === "number" ? String(value) : ""}
								placeholder={field.placeholder}
								min={field.min}
								max={field.max}
								step={field.step}
								onChange={(e) => {
									const raw = e.target.value;
									// 清空 = 删除该键（回落 schema 默认值），不是写 NaN
									if (raw === "") update({ [key]: undefined });
									else if (Number.isFinite(Number(raw))) update({ [key]: Number(raw) });
								}}
							/>
						</div>
					);
				}

				return (
					<div key={key} className="flex flex-col gap-1.5">
						{fieldCaption}
						{field.multiline ? (
							<textarea
								id={inputId}
								className={FIELD_CLASS}
								rows={3}
								value={typeof value === "string" ? value : ""}
								placeholder={field.placeholder}
								onChange={(e) => update({ [key]: e.target.value })}
							/>
						) : (
							<input
								id={inputId}
								type="text"
								className={FIELD_CLASS}
								value={typeof value === "string" ? value : ""}
								placeholder={field.placeholder}
								onChange={(e) => update({ [key]: e.target.value })}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}
