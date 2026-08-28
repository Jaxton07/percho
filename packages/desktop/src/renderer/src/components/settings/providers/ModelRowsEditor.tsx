import { useT } from "../../../i18n";
import { CloseIcon } from "../../icons";
import { Tooltip } from "../../ui/Tooltip";
import { EMPTY_MODEL_ROW, type ModelRow, parseTokenCount, splitPastedModelIds } from "./model-rows";

const inputClass =
	"w-full rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";

/** 模型行编辑器：每行一个模型；ctx/out 留空跟随 SDK 默认（128k/16k），非法值红框且禁止保存 */
export function ModelRowsEditor({ rows, onChange }: { rows: ModelRow[]; onChange: (rows: ModelRow[]) => void }) {
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
			<div className="flex items-center gap-3">
				<button
					type="button"
					className="rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover"
					onClick={() => onChange([...rows, { ...EMPTY_MODEL_ROW }])}
				>
					{t("settings.providers.addModelRow")}
				</button>
				{rows.some((row) => row.id.trim()) && (
					<button
						type="button"
						className="rounded-md px-1.5 py-1 text-[11px] text-ink-dim transition-colors hover:bg-hover"
						onClick={() => onChange([{ ...EMPTY_MODEL_ROW }])}
					>
						{t("settings.providers.clearModelRows")}
					</button>
				)}
			</div>
			<p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
				{t("settings.providers.customModelsHint")}
			</p>
			{rows.every((row) => !row.id.trim()) && (
				<p className="mt-1 text-[10px] leading-relaxed text-ink-dim">
					{t("settings.providers.customModelsEmptyHint")}
				</p>
			)}
		</div>
	);
}
