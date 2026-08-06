import { type CustomProviderInput, KNOWN_APIS, type ProviderInfo } from "@pi-desktop/shared";
import { useState } from "react";
import { type Language, useI18nStore, useT } from "../i18n";
import { useSettingsStore } from "../stores/settings";

type SettingsCategory = "general" | "providers" | "skills" | "mcp" | "extensions";

const CATEGORIES: SettingsCategory[] = ["general", "providers", "skills", "mcp", "extensions"];

/** 设置弹窗：左侧分类导航 + 右侧内容，两列均可独立滚动 */
export function SettingsDialog() {
	const t = useT();
	const open = useSettingsStore((s) => s.open);
	const setOpen = useSettingsStore((s) => s.setOpen);
	const [category, setCategory] = useState<SettingsCategory>("providers");

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" role="dialog" aria-modal>
			<div className="flex h-[70vh] w-[720px] flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
				<div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-4 py-3">
					<h2 className="text-sm font-semibold text-zinc-900">{t("settings.title")}</h2>
					<button
						type="button"
						className="rounded-lg px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
						onClick={() => setOpen(false)}
						aria-label={t("common.close")}
					>
						✕
					</button>
				</div>
				<div className="flex min-h-0 flex-1">
					<nav className="w-44 shrink-0 overflow-y-auto border-r border-zinc-100 p-2">
						{CATEGORIES.map((id) => (
							<button
								key={id}
								type="button"
								className={`mb-0.5 w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
									category === id
										? "bg-zinc-100 font-medium text-zinc-900"
										: "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800"
								}`}
								onClick={() => setCategory(id)}
							>
								{t(`settings.category.${id}`)}
							</button>
						))}
					</nav>
					<div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
						{category === "general" && <GeneralPanel />}
						{category === "providers" && <ProvidersPanel />}
						{category !== "general" && category !== "providers" && (
							<p className="py-8 text-center text-[13px] text-zinc-400">{t("settings.comingSoon")}</p>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function GeneralPanel() {
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

function ProvidersPanel() {
	const t = useT();
	const providers = useSettingsStore((s) => s.providers);
	const loading = useSettingsStore((s) => s.loading);
	const error = useSettingsStore((s) => s.error);

	return (
		<div>
			{error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600">{error}</p>}
			{loading && providers.length === 0 ? (
				<p className="py-8 text-center text-[13px] text-zinc-400">{t("settings.loading")}</p>
			) : (
				<ProviderList providers={providers} />
			)}
			<CustomProviderForm />
		</div>
	);
}

function ProviderList({ providers }: { providers: ProviderInfo[] }) {
	const t = useT();
	if (providers.length === 0) {
		return <p className="py-4 text-center text-[13px] text-zinc-400">{t("settings.providers.empty")}</p>;
	}
	return (
		<ul className="divide-y divide-zinc-100">
			{providers.map((provider) => (
				<ProviderRow key={provider.id} provider={provider} />
			))}
		</ul>
	);
}

function ProviderRow({ provider }: { provider: ProviderInfo }) {
	const t = useT();
	const saveKey = useSettingsStore((s) => s.saveKey);
	const removeCredential = useSettingsStore((s) => s.removeCredential);
	const removeCustom = useSettingsStore((s) => s.removeCustom);
	const test = useSettingsStore((s) => s.test);
	const testResult = useSettingsStore((s) => s.testResults[provider.id]);
	const [editing, setEditing] = useState(false);
	const [key, setKey] = useState("");

	const save = async () => {
		if (!key.trim()) return;
		await saveKey(provider.id, key);
		setEditing(false);
		setKey("");
	};

	return (
		<li className="py-2.5">
			<div className="flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate text-[13px] font-medium text-zinc-800">{provider.name}</span>
						{provider.custom && (
							<span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">
								{t("settings.providers.custom")}
							</span>
						)}
					</div>
					<div className="mt-0.5 text-[11px] text-zinc-400">
						{t("settings.providers.modelCount", { count: provider.models.length })}
						{provider.configured && provider.authLabel ? ` · ${provider.authLabel}` : ""}
					</div>
				</div>
				<span
					className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
						provider.configured ? "bg-emerald-50 text-emerald-600" : "bg-zinc-100 text-zinc-400"
					}`}
				>
					{provider.configured ? t("settings.providers.configured") : t("settings.providers.unconfigured")}
				</span>
				{provider.configured && (
					<button
						type="button"
						className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100"
						onClick={() => void test(provider.id)}
						disabled={testResult === "testing"}
					>
						{testResult === "testing" ? t("settings.providers.testing") : t("settings.providers.test")}
					</button>
				)}
				<button
					type="button"
					className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100"
					onClick={() => setEditing((v) => !v)}
				>
					{provider.configured ? t("settings.providers.updateKey") : t("settings.providers.configKey")}
				</button>
				{provider.custom ? (
					<button
						type="button"
						className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-red-500 transition-colors hover:bg-red-50"
						onClick={() => void removeCustom(provider.id)}
					>
						{t("common.delete")}
					</button>
				) : (
					provider.configured &&
					provider.authSource === "stored" && (
						<button
							type="button"
							className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-red-500 transition-colors hover:bg-red-50"
							onClick={() => void removeCredential(provider.id)}
						>
							{t("settings.providers.removeCredential")}
						</button>
					)
				)}
			</div>
			{testResult && testResult !== "testing" && (
				<p
					className={`mt-1.5 rounded-lg px-2.5 py-1.5 text-[11px] ${
						testResult.ok ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
					}`}
				>
					{testResult.ok
						? t("settings.providers.testOk", { modelId: testResult.modelId ?? "" })
						: t("settings.providers.testFailed", { error: testResult.error ?? "" })}
				</p>
			)}
			{editing && (
				<div className="mt-2 flex items-center gap-2">
					<input
						type="password"
						className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[12px] outline-none focus:border-zinc-400"
						placeholder={t("settings.providers.keyPlaceholder")}
						value={key}
						onChange={(e) => setKey(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && void save()}
					/>
					<button
						type="button"
						className="shrink-0 rounded-lg bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
						onClick={() => void save()}
						disabled={!key.trim()}
					>
						{t("common.save")}
					</button>
				</div>
			)}
		</li>
	);
}

function CustomProviderForm() {
	const t = useT();
	const addCustom = useSettingsStore((s) => s.addCustom);
	const [show, setShow] = useState(false);
	const [form, setForm] = useState({
		id: "",
		name: "",
		baseUrl: "",
		api: "openai-completions",
		models: "",
		apiKey: "",
	});
	const [submitting, setSubmitting] = useState(false);

	if (!show) {
		return (
			<button
				type="button"
				className="mt-3 w-full rounded-lg border border-dashed border-zinc-200 py-2 text-[13px] text-zinc-500 transition-colors hover:border-zinc-300 hover:bg-zinc-50"
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
			setForm({ id: "", name: "", baseUrl: "", api: "openai-completions", models: "", apiKey: "" });
		} catch {
			// 错误已写入 store.error
		} finally {
			setSubmitting(false);
		}
	};

	const inputClass =
		"w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[12px] outline-none focus:border-zinc-400";

	return (
		<div className="mt-3 rounded-xl border border-zinc-200 p-3">
			<h3 className="text-[13px] font-medium text-zinc-800">{t("settings.providers.customTitle")}</h3>
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
					className="rounded-lg px-3 py-1.5 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100"
					onClick={() => setShow(false)}
				>
					{t("common.cancel")}
				</button>
				<button
					type="button"
					className="rounded-lg bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
					onClick={() => void submit()}
					disabled={submitting || !form.id.trim() || !form.baseUrl.trim() || !form.models.trim()}
				>
					{submitting ? t("settings.providers.submitting") : t("common.save")}
				</button>
			</div>
		</div>
	);
}
