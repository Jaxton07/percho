/** 请求边界决策；SDK 的原生线严格大于，百分比线达到即触发。 */
export function decideRequestCompaction(input: {
	tokens: number;
	contextWindow: number;
	reserveTokens: number;
	thresholdPct: number;
}): { trigger: boolean; thresholdTokens: number } {
	const { tokens, contextWindow, reserveTokens, thresholdPct } = input;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(tokens)) {
		return { trigger: false, thresholdTokens: 0 };
	}
	const thresholdTokens = Math.min(
		Math.ceil((contextWindow * thresholdPct) / 100),
		contextWindow - reserveTokens + 1,
	);
	return { trigger: tokens >= thresholdTokens, thresholdTokens };
}
