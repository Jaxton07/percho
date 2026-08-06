import { type CustomProviderInput, KNOWN_APIS, type ProviderInfo } from "@pi-desktop/shared";
import { useState } from "react";
import { useSettingsStore } from "../stores/settings";

/** 设置弹窗：provider / 模型 / 凭证的可视化配置 */
export function SettingsDialog() {
	const open = useSettingsStore((s) => s.open);
	const setOpen = useSettingsStore((s) => s.setOpen);
	const providers = useSettingsStore((s) => s.providers);
	const loading = useSettingsStore((s) => s.loading);
	const error = useSettingsStore((s) => s.error);

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20" role="dialog" aria-modal>
			<div className="flex max-h-[80vh] w-[560px] flex-col rounded-xl border border-zinc-200 bg-white shadow-xl">
				<div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
					<h2 className="text-sm font-semibold text-zinc-900">模型与 Provider 设置</h2>
					<button
						type="button"
						className="rounded-lg px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
						onClick={() => setOpen(false)}
						aria-label="关闭"
					>
						✕
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
					{error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600">{error}</p>}
					{loading && providers.length === 0 ? (
						<p className="py-8 text-center text-[13px] text-zinc-400">加载中…</p>
					) : (
						<ProviderList providers={providers} />
					)}
					<CustomProviderForm />
				</div>
			</div>
		</div>
	);
}

function ProviderList({ providers }: { providers: ProviderInfo[] }) {
	if (providers.length === 0) {
		return <p className="py-4 text-center text-[13px] text-zinc-400">未发现可用 provider</p>;
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
							<span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">自定义</span>
						)}
					</div>
					<div className="mt-0.5 text-[11px] text-zinc-400">
						{provider.models.length} 个模型
						{provider.configured && provider.authLabel ? ` · ${provider.authLabel}` : ""}
					</div>
				</div>
				<span
					className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
						provider.configured ? "bg-emerald-50 text-emerald-600" : "bg-zinc-100 text-zinc-400"
					}`}
				>
					{provider.configured ? "已配置" : "未配置"}
				</span>
				{provider.configured && (
					<button
						type="button"
						className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100"
						onClick={() => void test(provider.id)}
						disabled={testResult === "testing"}
					>
						{testResult === "testing" ? "测试中…" : "测试"}
					</button>
				)}
				<button
					type="button"
					className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition-colors hover:bg-zinc-100"
					onClick={() => setEditing((v) => !v)}
				>
					{provider.configured ? "更新 Key" : "配置 Key"}
				</button>
				{provider.custom ? (
					<button
						type="button"
						className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-red-500 transition-colors hover:bg-red-50"
						onClick={() => void removeCustom(provider.id)}
					>
						删除
					</button>
				) : (
					provider.configured &&
					provider.authSource === "stored" && (
						<button
							type="button"
							className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-red-500 transition-colors hover:bg-red-50"
							onClick={() => void removeCredential(provider.id)}
						>
							移除凭证
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
					{testResult.ok ? `连接正常（${testResult.modelId}）` : `测试失败：${testResult.error}`}
				</p>
			)}
			{editing && (
				<div className="mt-2 flex items-center gap-2">
					<input
						type="password"
						className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[12px] outline-none focus:border-zinc-400"
						placeholder="粘贴 API Key，保存到 ~/.pi/agent/auth.json"
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
						保存
					</button>
				</div>
			)}
		</li>
	);
}

function CustomProviderForm() {
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
				+ 添加自定义 Provider
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
			<h3 className="text-[13px] font-medium text-zinc-800">自定义 Provider</h3>
			<div className="mt-2 grid grid-cols-2 gap-2">
				<input className={inputClass} placeholder="ID，如 ai-ops" value={form.id} onChange={set("id")} />
				<input className={inputClass} placeholder="显示名（可选）" value={form.name} onChange={set("name")} />
				<input
					className={`${inputClass} col-span-2`}
					placeholder="baseUrl，如 https://api.deepseek.com"
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
					placeholder="API Key（可选，存 auth.json）"
					type="password"
					value={form.apiKey}
					onChange={set("apiKey")}
				/>
				<textarea
					className={`${inputClass} col-span-2 resize-none`}
					rows={2}
					placeholder="模型 ID，逗号或换行分隔，如 deepseek-chat, deepseek-reasoner"
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
					取消
				</button>
				<button
					type="button"
					className="rounded-lg bg-zinc-900 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
					onClick={() => void submit()}
					disabled={submitting || !form.id.trim() || !form.baseUrl.trim() || !form.models.trim()}
				>
					{submitting ? "保存中…" : "保存"}
				</button>
			</div>
		</div>
	);
}
