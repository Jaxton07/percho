import { type CustomProviderInput, KNOWN_APIS } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";

const EMPTY_FORM = {
	id: "",
	name: "",
	baseUrl: "",
	api: "openai-completions",
	models: "",
	apiKey: "",
};

/** 自定义 provider 表单：id/baseUrl/api/模型列表/Key */
export function CustomProviderForm() {
	const t = useT();
	const addCustom = useSettingsStore((s) => s.addCustom);
	const [show, setShow] = useState(false);
	const [form, setForm] = useState(EMPTY_FORM);
	const [submitting, setSubmitting] = useState(false);

	if (!show) {
		return (
			<button
				type="button"
				className="mt-3 w-full rounded-lg border border-dashed border-border py-2 text-[13px] text-ink-dim transition-colors hover:border-border-strong hover:bg-hover"
				onClick={() => setShow(true)}
			>
				{t("settings.providers.addCustom")}
			</button>
		);
	}

	const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
		setForm((f) => ({ ...f, [field]: e.target.value }));

	const submit = async () => {
		const input: CustomProviderInput = {
			id: form.id,
			name: form.name || undefined,
			baseUrl: form.baseUrl,
			api: form.api,
			models: form.models
				.split(/[,\n]/)
				.map((s) => s.trim())
				.filter(Boolean)
				.map((id) => ({ id })),
			apiKey: form.apiKey || undefined,
		};
		setSubmitting(true);
		try {
			await addCustom(input);
			setShow(false);
			setForm(EMPTY_FORM);
		} catch {
			// 错误已写入 store.error
		} finally {
			setSubmitting(false);
		}
	};

	const inputClass =
		"w-full rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-ink-faint";

	return (
		<div className="mt-3 rounded-xl border border-border p-3">
			<h3 className="text-[13px] font-medium text-ink">{t("settings.providers.customTitle")}</h3>
			<div className="mt-2 grid grid-cols-2 gap-2">
				<input
					className={inputClass}
					placeholder={t("settings.providers.customId")}
					value={form.id}
					onChange={set("id")}
				/>
				<input
					className={inputClass}
					placeholder={t("settings.providers.customName")}
					value={form.name}
					onChange={set("name")}
				/>
				<input
					className={`${inputClass} col-span-2`}
					placeholder={t("settings.providers.customBaseUrl")}
					value={form.baseUrl}
					onChange={set("baseUrl")}
				/>
				<select className={inputClass} value={form.api} onChange={set("api")}>
					{KNOWN_APIS.map((api) => (
						<option key={api} value={api}>
							{api}
						</option>
					))}
				</select>
				<input
					className={inputClass}
					placeholder={t("settings.providers.customKey")}
					type="password"
					value={form.apiKey}
					onChange={set("apiKey")}
				/>
				<textarea
					className={`${inputClass} col-span-2 resize-none`}
					rows={2}
					placeholder={t("settings.providers.customModels")}
					value={form.models}
					onChange={set("models")}
				/>
			</div>
			<div className="mt-2 flex justify-end gap-2">
				<button
					type="button"
					className="rounded-lg px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover"
					onClick={() => setShow(false)}
				>
					{t("common.cancel")}
				</button>
				<button
					type="button"
					className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-40"
					onClick={() => void submit()}
					disabled={submitting || !form.id.trim() || !form.baseUrl.trim() || !form.models.trim()}
				>
					{submitting ? t("settings.providers.submitting") : t("common.save")}
				</button>
			</div>
		</div>
	);
}
