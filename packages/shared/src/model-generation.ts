/** 一次模型请求的实测统计。耗时包含首字等待、网络和思考，不含后续工具执行。 */
export interface ModelGenerationStats {
	outputTokens: number;
	durationMs: number;
}

/** 从 SDK 权威终态读取，不按字符数估算，也不将缺失统计伪造为零。 */
export function modelGenerationStats(message: unknown): ModelGenerationStats | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = message as {
		usage?: { output?: unknown } | null;
		durationMs?: unknown;
		stopReason?: unknown;
	};
	if (["error", "aborted", "deferred", "pending"].includes(String(value.stopReason))) return undefined;
	const outputTokens = value.usage?.output;
	const durationMs = value.durationMs;
	if (
		typeof outputTokens !== "number" ||
		!Number.isFinite(outputTokens) ||
		outputTokens < 0 ||
		typeof durationMs !== "number" ||
		!Number.isFinite(durationMs) ||
		durationMs <= 0
	)
		return undefined;
	return { outputTokens, durationMs };
}
