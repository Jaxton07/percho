import { type CustomProviderInput, KNOWN_APIS, type ProviderInfo } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";
import { Tooltip } from "../../ui/Tooltip";
import { ModelRowsEditor } from "./ModelRowsEditor";
import { EMPTY_MODEL_ROW, type ModelRow, modelsToRows, rowsToModelInputs, rowsValid } from "./model-rows";

interface ProviderFormState {
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	/** 逐模型行（id/上下文/输出/思考/图像），提交时经 rowsToModelInputs 转换 */
	models: ModelRow[];
	apiKey: string;
}

const EMPTY_FORM: ProviderFormState = {
	id: "",
	name: "",
	baseUrl: "",
	api: "openai-completions",
	models: [{ ...EMPTY_MODEL_ROW }],
	apiKey: "",
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

/** 自定义 provider 配置表单（添加/编辑共用）：id/baseUrl/api/模型列表/Key。根节点无外边距，由调用方控制间距 */
function ProviderConfigForm({
	title,
	initial,
	lockId,
	onSubmit,
	onCancel,
}: {
	title: string;
	initial: ProviderFormState;
	/** 编辑模式锁定 ID：它是 models.json/auth.json/会话模型引用的主键，不可改 */
	lockId?: boolean;
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
				/>
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
				// 只预填已落盘的自定义模型定义（避免把 runtime 全量内置模型写回 models.json）
				models: modelsToRows(provider.customModels ?? []),
			}}
			lockId
			onSubmit={async (form) => {
				await updateCustom(toInput(form));
				onDone();
			}}
			onCancel={onDone}
		/>
	);
}
