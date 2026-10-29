import type { UpstreamModelInfo } from "@percho/shared";

/** 上游 /models 请求超时：中转站不可达时不要挂住设置表单 */
export const UPSTREAM_TIMEOUT_MS = 15_000;

/** 保存表单时探测基址的超时：只用来判「根地址还是 /v1」，不该让保存按钮干等 */
export const BASE_URL_PROBE_TIMEOUT_MS = 5_000;

/** 只有这两种 OpenAI 兼容协议才可能缺 /v1 版本段（azure 端点是 deployments 路径，不能乱补） */
const VERSIONED_APIS = new Set(["openai-completions", "openai-responses"]);

/** 上游返回的一条原始模型（只有 ID 可信，能力元数据从 SDK 目录补） */
export interface RawUpstreamModel {
	id: string;
	name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 是否需要用 `/models` 探测补全版本段：仅「OpenAI 兼容协议 + 裸站点根」需要。
 * 地址已带路径（`/v1`、`/v1beta/openai`、`/api/paas/v4`、azure 的 `/openai`）时一律尊重用户输入。
 */
export function needsApiVersionProbe(baseUrl: string, api: string): boolean {
	if (!VERSIONED_APIS.has(api)) return false;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return false;
	}
	return (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash;
}

/**
 * 响应体是不是「模型清单」：数组，或带 data / models 数组的对象。
 * New API 这类网关对未知路径回 200 + 前端 HTML 首页，JSON.parse 会抛错；
 * 这里把「不是清单」也算失败，探测才不会被一张首页骗过去。
 */
export function looksLikeModelList(body: unknown): boolean {
	if (Array.isArray(body)) return true;
	if (!body || typeof body !== "object") return false;
	const record = body as Record<string, unknown>;
	return Array.isArray(record.data) || Array.isArray(record.models);
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
/** 目录条目（内部用）：额外带 provider/api，用于同一 ID 多 provider 时选正主 */
export interface CatalogModel extends UpstreamModelInfo {
	provider?: string;
	api?: string;
}

/**
 * 建立能力索引。同一个模型 ID 在目录里会挂在多个 provider 下（azure / copilot / cloudflare / openrouter…），
 * 各家 `thinkingLevelMap` 并不一致（如 azure 的 off 是 null、copilot 的 minimal 映射为 low）。
 * 给中转站补能力时优先取同一 api 家族下的厂商官方条目（`preferredProvider`），
 * 否则会把代理特有语义当成模型本身的能力。
 */
export function buildMetaIndex(
	models: readonly CatalogModel[],
	preference?: { provider?: string; api?: string },
): Map<string, UpstreamModelInfo> {
	const index = new Map<string, UpstreamModelInfo>();
	// 厂商官方条目 > 同协议条目 > 先到先得
	const rank = (model: CatalogModel): number => {
		if (!preference) return 0;
		if (preference.provider && model.provider === preference.provider) return 2;
		if (preference.api && model.api === preference.api) return 1;
		return 0;
	};
	const put = (key: string, model: CatalogModel) => {
		const existing = index.get(key);
		if (!existing || rank(model) > rank(existing as CatalogModel)) index.set(key, model);
	};
	for (const model of models) {
		const key = model.id.trim().toLowerCase();
		if (key) put(key, model);
	}
	for (const model of models) {
		for (const key of metaLookupKeys(model.id)) put(key, model);
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
			// 思考力度档位只能从内置目录带出来（/models 不返回），带出后与官方模型选择器一致
			...(meta?.thinkingLevelMap && Object.keys(meta.thinkingLevelMap).length > 0
				? { thinkingLevelMap: meta.thinkingLevelMap }
				: {}),
			...(meta?.contextWindow ? { contextWindow: meta.contextWindow } : {}),
			...(meta?.maxTokens ? { maxTokens: meta.maxTokens } : {}),
			...(meta?.imageInput ? { imageInput: true } : {}),
		};
	});
}

interface ModelsRequest {
	api: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

function trimBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

/** Anthropic 用 x-api-key，其余按 OpenAI 兼容用 Bearer */
function upstreamHeaders(api: string, apiKey: string): Record<string, string> {
	return api.startsWith("anthropic")
		? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
		: { Authorization: `Bearer ${apiKey}` };
}

/** 请求 `{base}/models` 并解析；把「回 HTML 首页」「不是模型清单」转成能看懂的失败原因 */
async function requestModels(baseUrl: string, request: ModelsRequest): Promise<RawUpstreamModel[]> {
	const fetchImpl = request.fetchImpl ?? fetch;
	const res = await fetchImpl(`${baseUrl}/models`, {
		headers: upstreamHeaders(request.api, request.apiKey),
		signal: AbortSignal.timeout(request.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`上游 /models 返回 HTTP ${res.status}`);
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw new Error("上游 /models 没有返回 JSON（地址可能少写 /v1，或这不是 API 端点）");
	}
	if (!looksLikeModelList(body)) {
		throw new Error("上游 /models 返回的不是模型清单（地址可能少写 /v1，或这不是 API 端点）");
	}
	return parseUpstreamModels(body);
}

/**
 * 把「站点根」补成真正可用的 OpenAI 兼容基址（保存配置与拉模型清单共用）。
 *
 * 中转站面板给的「API 地址」通常就是站点根，客户端要自己写 `/v1`；用户照抄后请求会打到
 * `{根}/chat/completions`，New API 这类网关对未知路径回 200 + 前端 HTML 首页，SDK 按 SSE 解出
 * 空流，只报「Stream ended without finish_reason」——完全看不出是地址少了版本段。
 *
 * 只在 `needsApiVersionProbe` 成立时并发探测 `{根}/models` 与 `{根}/v1/models`，取成功的那个
 * （根地址自己就能返回清单时保持原样，尊重用户输入）；都失败（离线/密钥错）就原样返回，不阻断保存。
 */
export async function resolveUpstreamBaseUrl(input: {
	baseUrl: string;
	api: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<{ baseUrl: string; normalized: boolean }> {
	const baseUrl = trimBaseUrl(input.baseUrl);
	if (!needsApiVersionProbe(baseUrl, input.api)) return { baseUrl, normalized: false };
	const candidates = [baseUrl, `${baseUrl}/v1`];
	// 并发探测：根地址不通时不必先等满一个超时再试 /v1
	const results = await Promise.allSettled(candidates.map((candidate) => requestModels(candidate, input)));
	for (const [index, result] of results.entries()) {
		if (result.status === "fulfilled")
			return { baseUrl: candidates[index] ?? baseUrl, normalized: index > 0 };
	}
	return { baseUrl, normalized: false };
}

/**
 * 拉上游模型清单，同时回传实际可用的基址（表单据此把补全后的地址回填给用户）。
 * 裸站点根时按「根 → /v1」顺序试，失败原因取最后一次（/v1 才是多数网关的意图地址）。
 */
export async function fetchUpstreamModels(input: {
	baseUrl: string;
	api: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
}): Promise<{ models: RawUpstreamModel[]; baseUrl: string }> {
	const baseUrl = trimBaseUrl(input.baseUrl);
	if (!needsApiVersionProbe(baseUrl, input.api)) {
		return { models: await requestModels(baseUrl, input), baseUrl };
	}
	let lastError: unknown;
	for (const candidate of [baseUrl, `${baseUrl}/v1`]) {
		try {
			return { models: await requestModels(candidate, input), baseUrl: candidate };
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}
