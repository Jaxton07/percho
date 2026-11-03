/**
 * 轮次速度派生（纯函数）：轮内逐条 LLM 消息样本 → 聚合生成速度（token 速度组件数据源）。
 *
 * 口径：speed = Σ 输出 token ÷ Σ 生成耗时。分子/分母来自 assistant 原始消息的两个字段（pi SDK
 * AssistantMessage，jsonl/事件流均携带）：
 * - output = usage.output（该消息实际生成的 token 数，API 权威值，非文本估算）
 * - durationMs = message.durationMs（SDK AssistantMessageEventStream 实测：请求发出 → 完成；
 *   逐消息累加 = 纯 LLM 生成时间，天然排除工具执行、排队与消息间隙）
 *
 * 样本校验（不达标丢弃；全部丢弃 → 返回 null，宁缺勿错——历史轮/缺字段轮不显示假速度）：
 * - stopReason === "error"（失败请求）跳过——重试轮的失败尝试（低输出/短耗时）会稀释速度；
 * - output 必须是有限数且 ≥ 0；
 * - durationMs 必须是有限数且 > 0；
 * - output ≤ durationMs（等价于拒绝 >1000 tok/s 的不可信样本，如 durationMs 缺失退化值）。
 *
 * 轮边界与 deriveTurnTimings 同规则（最近一条 user 消息之后）；取样本与切片由调用方负责。
 */

/** 单条 assistant 消息的原始字段样本（透传原始值；类型校验在 deriveTurnSpeed 内完成） */
export interface TurnSpeedSample {
	/** pi AssistantMessage.usage.output（缺省 = 该消息无 usage） */
	output?: unknown;
	/** pi AssistantMessage.durationMs（缺省 = 该消息未测得生成耗时） */
	durationMs?: unknown;
	/** pi AssistantMessage.stopReason（"error" = 失败请求，不计入样本） */
	stopReason?: unknown;
}

/** 一轮的聚合生成速度 */
export interface TurnSpeedInfo {
	/** 轮内 Σ 输出 token */
	outputTokens: number;
	/** 轮内 Σ 生成耗时（ms）；不含工具执行/排队 */
	durationMs: number;
	/** outputTokens ÷ (durationMs / 1000) */
	speed: number;
	/** 有效样本数（计入的 LLM 消息条数） */
	samples: number;
}

/** 轮内样本 → 聚合速度；无有效样本返回 null */
export function deriveTurnSpeed(samples: readonly TurnSpeedSample[]): TurnSpeedInfo | null {
	let tokens = 0;
	let duration = 0;
	let count = 0;
	for (const sample of samples) {
		if (sample.stopReason === "error") continue;
		const output = sample.output;
		const durationMs = sample.durationMs;
		if (typeof output !== "number" || !Number.isFinite(output) || output < 0) continue;
		if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) continue;
		if (output > durationMs) continue;
		tokens += output;
		duration += durationMs;
		count++;
	}
	if (count === 0) return null;
	return { outputTokens: tokens, durationMs: duration, speed: tokens / (duration / 1000), samples: count };
}
