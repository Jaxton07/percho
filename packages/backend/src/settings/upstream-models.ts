import type { UpstreamModelInfo } from "@percho/shared";

/** 上游 /models 请求超时：中转站不可达时不要挂住设置表单 */
export const UPSTREAM_TIMEOUT_MS = 15_000;

/** 上游返回的一条原始模型（只有 ID 可信，能力元数据从 SDK 目录补） */
export interface RawUpstreamModel {
	id: string;
	name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 解析 /models 响应：OpenAI/Anthropic 走 `{data:[…]}`，部分中转站走 `{models:[…]}` 或裸数组，
 * 条目可能是字符串或 `{id,name}`。按 ID 去重并保持上游顺序。
 */
export function parseUpstreamModels(body: unknown): RawUpstreamModel[] {
	const list = Array.isArray(body)
		? body
		: isRecord(body) && Array.isArray(body.data)
			? body.data
			: isRecord(body) && Array.isArray(body.models)
				? body.models
				: [];
	const seen = new Set<string>();
	const out: RawUpstreamModel[] = [];
	for (const item of list) {
		const id = (
			typeof item === "string" ? item : isRecord(item) && typeof item.id === "string" ? item.id : ""
		).trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const name =
			isRecord(item) && typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined;
		out.push({ id, ...(name ? { name } : {}) });
	}
	return out;
}

/**
 * 目录查询的退化键：原 ID → 去掉厂商前缀（`vendor/model`）→ 去掉日期后缀（`-261017`）。
 * 中转站常把版本号/日期拼进 ID，而 SDK 目录里是同名上游模型。
 */
export function metaLookupKeys(id: string): string[] {
	const key = id.trim().toLowerCase();
	if (!key) return [];
	const keys = new Set<string>([key]);
	const tail = key.split("/").pop();
	if (tail && tail !== key) keys.add(tail);
	for (const candidate of [...keys]) {
		const undated = candidate.replace(/[-_.]?(19|20)\d{6}$/, "").replace(/[-_.]?\d{6}$/, "");
		if (undated && undated !== candidate) keys.add(undated);
	}
	return [...keys];
}

/** 先收齐精确 ID，再补别名；别名不能抢占后面的精确模型。相同 ID 仍保持目录顺序。 */
export function buildMetaIndex(models: readonly UpstreamModelInfo[]): Map<string, UpstreamModelInfo> {
	const index = new Map<string, UpstreamModelInfo>();
	for (const model of models) {
		const key = model.id.trim().toLowerCase();
		if (key && !index.has(key)) index.set(key, model);
	}
	for (const model of models) {
		for (const key of metaLookupKeys(model.id)) if (!index.has(key)) index.set(key, model);
	}
	return index;
}

/** 上游一条模型 → 带能力元数据的行；目录里查不到时只回 ID（表单留空 = SDK 默认） */
export function enrichUpstreamModels(
	raw: readonly RawUpstreamModel[],
	index: Map<string, UpstreamModelInfo>,
): UpstreamModelInfo[] {
	return raw.map(({ id, name }) => {
		let meta: UpstreamModelInfo | undefined;
		for (const key of metaLookupKeys(id)) {
			meta = index.get(key);
			if (meta) break;
		}
		return {
			id,
			...((name ?? meta?.name) ? { name: name ?? meta?.name } : {}),
			...(meta?.reasoning ? { reasoning: true } : {}),
			...(meta?.contextWindow ? { contextWindow: meta.contextWindow } : {}),
			...(meta?.maxTokens ? { maxTokens: meta.maxTokens } : {}),
			...(meta?.imageInput ? { imageInput: true } : {}),
		};
	});
}

/** 拉上游模型清单：Anthropic 用 x-api-key，其余按 OpenAI 兼容用 Bearer */
export async function fetchUpstreamModels(input: {
	baseUrl: string;
	api: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
}): Promise<RawUpstreamModel[]> {
	const url = `${input.baseUrl.trim().replace(/\/+$/, "")}/models`;
	const headers: Record<string, string> = input.api.startsWith("anthropic")
		? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
		: { Authorization: `Bearer ${input.apiKey}` };
	const fetchImpl = input.fetchImpl ?? fetch;
	const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`上游 /models 返回 HTTP ${res.status}`);
	return parseUpstreamModels(await res.json());
}
