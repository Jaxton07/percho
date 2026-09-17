import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { QuotaInfo, QuotaWindowKey } from "@percho/shared";

/** opencode-go 套餐额度：官方 API（main 进程直调，renderer 沙箱禁网） */
const QUOTA_ENDPOINT = "https://opencode.ai/zen/go/v1/usage";
const QUOTA_PROVIDER = "opencode-go";
const QUOTA_TTL_MS = 300_000;
/** 官方文档额度（美元）：5 小时滚动 / 日历周 / 计费月 */
const QUOTA_WINDOW_LIMIT_USD: Record<QuotaWindowKey, number> = { rolling: 12, weekly: 30, monthly: 60 };
const QUOTA_WINDOW_LABEL: Record<QuotaWindowKey, string> = {
	rolling: "5h",
	weekly: "week",
	monthly: "month",
};

export interface QuotaService {
	/**
	 * 套餐额度（全局，非会话级）。5 分钟 TTL；无 key/无订阅返回 null（插件隐藏）；
	 * HTTP/网络失败返回带 error 的空窗体。
	 */
	get(): Promise<QuotaInfo | null>;
}

/** 从 PiBackend 抽出的额度服务：cache 闭包内聚，凭据经 runtime.getAuth 解析 */
export function makeQuotaService(getRuntime: () => Promise<ModelRuntime>): QuotaService {
	let cache: { at: number; data: QuotaInfo } | null = null;
	return {
		async get(): Promise<QuotaInfo | null> {
			const now = Date.now();
			if (cache && now - cache.at < QUOTA_TTL_MS) return cache.data;
			let apiKey: string | undefined;
			try {
				const runtime = await getRuntime();
				const auth = await runtime.getAuth(QUOTA_PROVIDER);
				apiKey = auth?.auth.apiKey;
			} catch {
				apiKey = undefined;
			}
			if (!apiKey) return null;
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 10_000);
				let res: Response;
				try {
					res = await fetch(QUOTA_ENDPOINT, {
						headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
						signal: controller.signal,
					});
				} finally {
					clearTimeout(timer);
				}
				if (!res.ok) {
					const err: QuotaInfo = { windows: [], updatedAt: now, error: `HTTP ${res.status}` };
					cache = { at: now, data: err };
					return err;
				}
				const data = (await res.json()) as {
					usage?: Record<string, { percent?: number; resetsAt?: string; status?: string }>;
				};
				const usage = data?.usage ?? {};
				const windows: QuotaInfo["windows"] = [];
				for (const key of ["rolling", "weekly", "monthly"] as const) {
					const w = usage[key];
					if (!w || typeof w !== "object") continue;
					const percent = Math.min(100, Math.max(0, Number(w.percent) || 0));
					windows.push({
						key,
						label: QUOTA_WINDOW_LABEL[key] ?? key,
						percent,
						resetsAt: w.resetsAt ?? null,
						usedUsd: QUOTA_WINDOW_LIMIT_USD[key] > 0 ? (percent / 100) * QUOTA_WINDOW_LIMIT_USD[key] : null,
						limitUsd: QUOTA_WINDOW_LIMIT_USD[key] ?? 0,
						status: w.status === "rate-limited" || percent >= 100 ? "rate-limited" : "ok",
					});
				}
				const info: QuotaInfo = { windows, updatedAt: now };
				cache = { at: now, data: info };
				return info;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return { windows: [], updatedAt: now, error: message };
			}
		},
	};
}
