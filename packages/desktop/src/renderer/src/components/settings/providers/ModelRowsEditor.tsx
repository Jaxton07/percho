import type { UpstreamModelInfo } from "@percho/shared";
import { useRef, useState } from "react";
import { useT } from "../../../i18n";
import { ChevronDownIcon, CloseIcon } from "../../icons";
import { anchorOfElement, type MenuAnchor } from "../../ui/place-menu";
import { Popup, SelectItem } from "../../ui/Select";
import { Tooltip } from "../../ui/Tooltip";
import {
	EMPTY_MODEL_ROW,
	type ModelRow,
	parseTokenCount,
	rowFromUpstreamModel,
	splitPastedModelIds,
} from "./model-rows";

const inputClass =
	"w-full rounded-lg border border-border px-2.5 py-1.5 text-ui-12 outline-none focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";

/** 候选列表里的能力摘要：按 k / M 缩写，避免 1048576 这种长数字把行挤爆 */
function compactTokens(n: number): string {
	return n >= 1_000_000
		? `${Math.round(n / 1_000_000)}M`
		: n >= 1000
			? `${Math.round(n / 1000)}k`
			: String(n);
}

/**
 * 模型 ID 输入 + 上游候选下拉（options 为空时不显示箭头）。
 * 选中一条即用 rowFromUpstreamModel 把 ID、上下文、输出、思考、图像一次填好。
 */
function ModelIdField({
	value,
	options,
	onChange,
	onPaste,
	onPick,
}: {
	value: string;
	options: readonly UpstreamModelInfo[];
	onChange: (value: string) => void;
	onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
	onPick: (model: UpstreamModelInfo) => void;
}) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const [anchor, setAnchor] = useState<MenuAnchor | null>(null);

	return (
		<div className="relative min-w-0 flex-1">
			<input
				ref={inputRef}
				className={`${inputClass} ${options.length > 0 ? "pr-7" : ""}`}
				placeholder={t("settings.providers.customModelId")}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onPaste={onPaste}
			/>
			{options.length > 0 && (
				<button
					type="button"
					aria-label={t("settings.providers.pickUpstreamModel")}
					aria-expanded={anchor !== null}
					className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink-dim"
					onClick={() => {
						const el = inputRef.current;
						setAnchor((prev) => (prev ? null : el ? anchorOfElement(el) : null));
					}}
				>
					<ChevronDownIcon size={9} />
				</button>
			)}
			{anchor && (
				<Popup anchor={anchor} width={anchor.width} onClose={() => setAnchor(null)}>
					{options.map((model) => (
						<SelectItem
							key={model.id}
							selected={model.id === value}
							trailing={[model.contextWindow, model.maxTokens]
								.filter((n): n is number => n !== undefined)
								.map(compactTokens)
								.join(" / ")}
							onSelect={() => {
								onPick(model);
								setAnchor(null);
							}}
						>
							{model.id}
						</SelectItem>
					))}
				</Popup>
			)}
		</div>
	);
}

/** 模型行编辑器：每行一个模型；ctx/out 留空跟随 SDK 默认（128k/16k），非法值红框且禁止保存 */
export function ModelRowsEditor({
	rows,
	onChange,
	upstream = [],
	fetching = false,
	fetchError = null,
	onFetch,
}: {
	rows: ModelRow[];
	onChange: (rows: ModelRow[]) => void;
	/** 从上游 /models 拉到的候选（已带 SDK 目录补全的能力）；空 = 还没获取过 */
	upstream?: readonly UpstreamModelInfo[];
	fetching?: boolean;
	fetchError?: string | null;
	/** 触发「自动获取模型」；不传则不显示该按钮 */
	onFetch?: () => void;
}) {
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
			className={`shrink-0 rounded-md border px-1.5 py-1 text-ui-10 transition-colors ${
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
					<ModelIdField
						value={row.id}
						options={upstream}
						onChange={(id) => setRow(i, { id })}
						onPaste={onIdPaste(i)}
						onPick={(model) => setRow(i, rowFromUpstreamModel(model))}
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
					className="rounded-md px-1.5 py-1 text-ui-11 text-ink-dim transition-colors hover:bg-hover"
					onClick={() => onChange([...rows, { ...EMPTY_MODEL_ROW }])}
				>
					{t("settings.providers.addModelRow")}
				</button>
				{onFetch && (
					<button
						type="button"
						className="rounded-md px-1.5 py-1 text-ui-11 text-ink-dim transition-colors hover:bg-hover disabled:opacity-40"
						disabled={fetching}
						onClick={onFetch}
					>
						{fetching ? t("settings.providers.fetchingUpstream") : t("settings.providers.fetchUpstream")}
					</button>
				)}
				{rows.some((row) => row.id.trim()) && (
					<button
						type="button"
						className="rounded-md px-1.5 py-1 text-ui-11 text-ink-dim transition-colors hover:bg-hover"
						onClick={() => onChange([{ ...EMPTY_MODEL_ROW }])}
					>
						{t("settings.providers.clearModelRows")}
					</button>
				)}
			</div>
			{upstream.length > 0 && (
				<p className="mt-1 text-ui-10 leading-relaxed text-ink-dim">
					{t("settings.providers.upstreamFetched", { count: upstream.length })}
				</p>
			)}
			{fetchError && (
				<p className="mt-1 text-ui-10 leading-relaxed text-err">
					{t("settings.providers.upstreamError", { message: fetchError })}
				</p>
			)}
			<p className="mt-1 text-ui-10 leading-relaxed text-ink-faint">
				{t("settings.providers.customModelsHint")}
			</p>
			{rows.every((row) => !row.id.trim()) && (
				<p className="mt-1 text-ui-10 leading-relaxed text-ink-dim">
					{t("settings.providers.customModelsEmptyHint")}
				</p>
			)}
		</div>
	);
}
