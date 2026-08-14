import { type CustomProviderInput, KNOWN_APIS, type ProviderInfo } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";
import { CloseIcon } from "../../icons";
import { Tooltip } from "../../ui/Tooltip";
import {
	EMPTY_MODEL_ROW,
	type ModelRow,
	modelsToRows,
	parseTokenCount,
	rowsToModelInputs,
	rowsValid,
	splitPastedModelIds,
} from "./model-rows";

interface ProviderFormState {
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	/** 逐模型行（id/上下文/输出/思考/图像），提交时经 rowsToModelInputs 转换 */
	models: ModelRow[];
	apiKey: string;
	clearKey: boolean;
}

const EMPTY_FORM: ProviderFormState = {
	id: "",
	name: "",
	baseUrl: "",
	api: "openai-completions",
	models: [{ ...EMPTY_MODEL_ROW }],
	apiKey: "",
	clearKey: false,
};

function toInput(form: ProviderFormState): CustomProviderInput {
	return {
		id: form.id,
		name: form.name || undefined,
		baseUrl: form.baseUrl,
		api: form.api,
		models: rowsToModelInputs(form.models),
		apiKey: form.apiKey || undefined,
	};
}

const inputClass =
	"w-full rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";

/** 模型行编辑器：每行一个模型；ctx/out 留空跟随 SDK 默认（128k/16k），非法值红框且禁止保存 */
function ModelRowsEditor({ rows, onChange }: { rows: ModelRow[]; onChange: (rows: ModelRow[]) => void }) {
	const t = useT();

	const setRow = (index: number, patch: Partial<ModelRow>) =>
		onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

	const removeRow = (index: number) => {
		const next = rows.filter((_, i) => i !== index);
		onChange(next.length > 0 ? next : [{ ...EMPTY_MODEL_ROW }]);
	};

	/** 中转站文档常是模型列表，粘贴逗号/换行分隔文本时自动拆成多行 */
	const onIdPaste = (index: number) => (e: React.ClipboardEvent<HTMLInputElement>) => {
		const ids = splitPastedModelIds(e.clipboardData.getData("text"));
		if (!ids) return;
		e.preventDefault();
		const next = [...rows];
		const current = next[index];
		if (!current) return;
		if (current.id.trim()) {
			next.splice(index + 1, 0, ...ids.map((id) => ({ ...EMPTY_MODEL_ROW, id })));
		} else {
			next[index] = { ...current, id: ids[0] };
			next.splice(index + 1, 0, ...ids.slice(1).map((id) => ({ ...EMPTY_MODEL_ROW, id })));
		}
		onChange(next);
	};

	const numberField = (value: string, placeholder: string, onValue: (v: string) => void, tooltip: string) => {
		const invalid = value.trim() !== "" && parseTokenCount(value) === null;
		return (
			<Tooltip label={tooltip} className="w-[4.5rem] shrink-0">
				<input
					className={`${inputClass} text-center ${invalid ? "border-red-400" : ""}`}
					placeholder={placeholder}
					value={value}
					onChange={(e) => onValue(e.target.value)}
				/>
			</Tooltip>
		);
	};

	const toggle = (active: boolean, label: string, onToggle: () => void) => (
		<button
			type="button"
			aria-pressed={active}
			className={`shrink-0 rounded-md border px-1.5 py-1 text-[10px] transition-colors ${
				active ? "border-ink-faint bg-hover text-ink" : "border-border text-ink-faint hover:text-ink-dim"
			}`}
			onClick={onToggle}
		>
			{label}
		</button>
	);

	return (
		<div className="col-span-2">
			{rows.map((row, i) => (
				// 行随增删变化，无稳定 id，用序号做 key（局部编辑器，重排场景不存在）
				// biome-ignore lint/suspicious/noArrayIndexKey: 行编辑器无稳定标识
				<div key={i} className="mb-1.5 flex items-center gap-1.5">
					<input
						className={`${inputClass} min-w-0 flex-1`}
						placeholder={t("settings.providers.customModelId")}
						value={row.id}
						onChange={(e) => setRow(i, { id: e.target.value })}
						onPaste={onIdPaste(i)}
					/>
					{numberField(
						row.contextWindow,
						"ctx 128k",
						(v) => setRow(i, { contextWindow: v }),
						t("settings.providers.customModelCtx"),
					)}
					{numberField(
						row.maxTokens,
						"out 16k",
						(v) => setRow(i, { maxTokens: v }),
						t("settings.providers.customModelOut"),
					)}
					{toggle(row.reasoning, t("settings.providers.customModelReasoning"), () =>
						setRow(i, { reasoning: !row.reasoning }),
					)}
					{toggle(row.imageInput, t("settings.providers.customModelImage"), () =>
						setRow(i, { imageInput: !row.imageInput }),
					)}
					<button
						type="button"
						aria-label={t("settings.providers.removeModelRow")}
						className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-hover hover:text-ink-dim"
						onClick={() => removeRow(i)}
					>
						<CloseIcon size={9} />
					</button>
				</div>
			))}
			<button
				type="button"
				className="rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover"
				onClick={() => onChange([...rows, { ...EMPTY_MODEL_ROW }])}
			>
				{t("settings.providers.addModelRow")}
			</button>
			<p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
				{t("settings.providers.customModelsHint")}
			</p>
		</div>
	);
}

/** 自定义 provider 配置表单（添加/编辑共用）：id/baseUrl/api/模型列表/Key。根节点无外边距，由调用方控制间距 */
function ProviderConfigForm({
	title,
	initial,
	lockId,
	allowClearKey,
	onSubmit,
	onCancel,
}: {
	title: string;
	initial: ProviderFormState;
	/** 编辑模式锁定 ID：它是 models.json/auth.json/会话模型引用的主键，不可改 */
	lockId?: boolean;
	/** 显示「清除已保存的 Key」选项（凭证存于 auth.json 的编辑场景） */
	allowClearKey?: boolean;
	onSubmit: (form: ProviderFormState) => Promise<void>;
	onCancel: () => void;
}) {
	const t = useT();
	const [form, setForm] = useState(initial);
	const [submitting, setSubmitting] = useState(false);

	const set = (field: keyof ProviderFormState) => (e: { target: { value: string } }) =>
		setForm((f) => ({ ...f, [field]: e.target.value }));

	const submit = async () => {
		setSubmitting(true);
		try {
			await onSubmit(form);
		} catch {
			// 错误已写入 store.error，表单保持打开
		} finally {
			setSubmitting(false);
		}
	};

	// models.json 里的 api 理论上必是 KnownApiId；防御性兜底，不在表内也照常显示当前值
	const apiOptions = (KNOWN_APIS as readonly string[]).includes(form.api)
		? KNOWN_APIS
		: [form.api, ...KNOWN_APIS];

	const idInput = (
		<input
			className={inputClass}
			placeholder={t("settings.providers.customId")}
			value={form.id}
			onChange={set("id")}
			disabled={lockId}
		/>
	);

	return (
		<div className="rounded-xl border border-border p-3">
			<h3 className="text-[13px] font-medium text-ink">{title}</h3>
			<div className="mt-2 grid grid-cols-2 gap-2">
				{lockId ? (
					<Tooltip label={t("settings.providers.customIdLocked")} className="w-full">
						{idInput}
					</Tooltip>
				) : (
					idInput
				)}
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
					{apiOptions.map((api) => (
						<option key={api} value={api}>
							{api}
						</option>
					))}
				</select>
				<input
					className={inputClass}
					placeholder={lockId ? t("settings.providers.customKeyKeep") : t("settings.providers.customKey")}
					type="password"
					value={form.apiKey}
					onChange={set("apiKey")}
					disabled={form.clearKey}
				/>
				{allowClearKey && (
					<label className="col-span-2 flex items-center gap-1.5 text-[11px] text-ink-dim">
						<input
							type="checkbox"
							className="h-3 w-3 accent-ink"
							checked={form.clearKey}
							onChange={(e) => setForm((f) => ({ ...f, clearKey: e.target.checked }))}
						/>
						{t("settings.providers.customKeyClear")}
					</label>
				)}
				<ModelRowsEditor rows={form.models} onChange={(models) => setForm((f) => ({ ...f, models }))} />
			</div>
			<div className="mt-2 flex justify-end gap-2">
				<button
					type="button"
					className="rounded-lg px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover"
					onClick={onCancel}
				>
					{t("common.cancel")}
				</button>
				<button
					type="button"
					className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-40"
					onClick={() => void submit()}
					disabled={submitting || !form.id.trim() || !form.baseUrl.trim() || !rowsValid(form.models)}
				>
					{submitting ? t("settings.providers.submitting") : t("common.save")}
				</button>
			</div>
		</div>
	);
}

/** 添加自定义 provider：折叠按钮 + 展开表单（取消/保存后收起即重置） */
export function CustomProviderForm() {
	const t = useT();
	const addCustom = useSettingsStore((s) => s.addCustom);
	const [show, setShow] = useState(false);

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

	return (
		<div className="mt-3">
			<ProviderConfigForm
				title={t("settings.providers.customTitle")}
				initial={EMPTY_FORM}
				onSubmit={async (form) => {
					await addCustom(toInput(form));
					setShow(false);
				}}
				onCancel={() => setShow(false)}
			/>
		</div>
	);
}

/** 编辑已添加的自定义 provider（ProviderRow 行内展开）：全字段可改，ID 锁定，Key 留空保持不变 */
export function CustomProviderEditForm({ provider, onDone }: { provider: ProviderInfo; onDone: () => void }) {
	const t = useT();
	const updateCustom = useSettingsStore((s) => s.updateCustom);

	return (
		<ProviderConfigForm
			title={t("settings.providers.editCustomTitle")}
			initial={{
				...EMPTY_FORM,
				id: provider.id,
				// ProviderInfo.name 缺省回落为 id；无显示名时保持空，让 placeholder 生效
				name: provider.name !== provider.id ? provider.name : "",
				baseUrl: provider.baseUrl ?? "",
				api: provider.api ?? "openai-completions",
				models: modelsToRows(provider.models),
			}}
			lockId
			allowClearKey={provider.authSource === "stored"}
			onSubmit={async (form) => {
				await updateCustom({ ...toInput(form), clearApiKey: form.clearKey || undefined });
				onDone();
			}}
			onCancel={onDone}
		/>
	);
}
