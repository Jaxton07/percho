import type { CustomProviderModelInput, ProviderModelInfo } from "@percho/shared";

/** 模型行编辑器的一行：数字字段保留原文（支持 k 后缀），提交时才解析 */
export interface ModelRow {
	id: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	imageInput: boolean;
}

export const EMPTY_MODEL_ROW: ModelRow = {
	id: "",
	contextWindow: "",
	maxTokens: "",
	reasoning: false,
	imageInput: false,
};

/**
 * 解析 token 数：支持裸数字与 k/K 后缀（256k = 256000，与 SDK 128000 约定同基）。
 * 返回 null = 非法；空串由调用方先判（表示「未设置」）。
 */
export function parseTokenCount(raw: string): number | null {
	const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*k?$/i);
	const numPart = match?.[1];
	if (numPart === undefined) return null;
	const value = Number.parseFloat(numPart) * (/k/i.test(raw.trim()) ? 1000 : 1);
	if (!Number.isInteger(value) || value <= 0) return null;
	return value;
}

/** 数字 → 行内显示：整千折叠为 k（256000 → "256k"），否则原样 */
export function formatTokenCount(value: number): string {
	return value >= 1000 && value % 1000 === 0 ? `${value / 1000}k` : String(value);
}

/** ProviderInfo.models（models.json 原文回填）→ 编辑表单行 */
export function modelsToRows(models: ProviderModelInfo[]): ModelRow[] {
	const rows = models.map((m) => ({
		id: m.id,
		contextWindow: m.contextWindow !== undefined ? formatTokenCount(m.contextWindow) : "",
		maxTokens: m.maxTokens !== undefined ? formatTokenCount(m.maxTokens) : "",
		reasoning: m.reasoning === true,
		imageInput: m.imageInput === true,
	}));
	return rows.length > 0 ? rows : [{ ...EMPTY_MODEL_ROW }];
}

/** 表单行 → CustomProviderModelInput（空 id 行丢弃；数字字段在此处已保证合法，见 rowsValid） */
export function rowsToModelInputs(rows: ModelRow[]): CustomProviderModelInput[] {
	return rows
		.filter((row) => row.id.trim())
		.map((row) => ({
			id: row.id.trim(),
			reasoning: row.reasoning || undefined,
			contextWindow: (row.contextWindow.trim() && parseTokenCount(row.contextWindow)) || undefined,
			maxTokens: (row.maxTokens.trim() && parseTokenCount(row.maxTokens)) || undefined,
			imageInput: row.imageInput || undefined,
		}));
}

/** 至少一行有 id，且所有 ctx/out 输入要么留空要么合法 */
export function rowsValid(rows: ModelRow[]): boolean {
	if (!rows.some((row) => row.id.trim())) return false;
	return rows.every(
		(row) =>
			(!row.contextWindow.trim() || parseTokenCount(row.contextWindow) !== null) &&
			(!row.maxTokens.trim() || parseTokenCount(row.maxTokens) !== null),
	);
}

/** 粘贴文本含逗号/换行时拆成模型 ID 列表（中转站文档常是列表，直接粘贴成多行） */
export function splitPastedModelIds(text: string): [string, ...string[]] | null {
	if (!/[,\n]/.test(text)) return null;
	const ids = text
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
	const [first, ...rest] = ids;
	return first === undefined ? null : [first, ...rest];
}
