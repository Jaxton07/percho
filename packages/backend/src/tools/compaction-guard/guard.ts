/**
 * 触发判定与退避（纯函数层，零 SDK / 零仓库 import）。
 *
 * 决策规则（spec D1/D2/D6）：
 * - 触发线：`percent = tokens / model.contextWindow × 100`，`percent ≥ thresholdPct` 才触发；
 * - 防抖：同一 `agent_settled` 周期只触发一次（由调用方持状态保证）+ 自上次触发起「冷却 × 退避倍数」；
 * - **两条退避阶梯**（spec D6，review 阶段 1 裁定）：
 *   - `ineffective`（压缩成功但没降下来）：倍数 1→2→4，**连续 3 次即停手**（继续硬打没意义）；
 *   - `failed`（网络/配额/提供商报错）：同一倍数阶梯但**不封顶**（最大 8×cooldownMs），
 *     **任意一次成功压缩后清零**——瞬时失败不该被当成「压缩没用」的证据（那会把护栏永久关掉）。
 */

import type { CompactionGuardConfig } from "./types";

export interface GuardState {
	/** 上次主动触发时刻（ms）；null = 本会话还没触发过 */
	lastTriggerAt: number | null;
	/** 连续无效压缩次数（0..MAX_INEFFECTIVE_STREAK） */
	ineffectiveStreak: number;
	/** 连续压缩失败次数（不封顶，影响冷却倍数但最多 ×8） */
	failedStreak: number;
}

/** 连续无效到该次数后不再主动触发（spec D6 的「3 次递增退避」） */
export const MAX_INEFFECTIVE_STREAK = 3;

/** 「下降 < 5%」判定阈值（百分点，spec D6） */
export const INEFFECTIVE_DROP_PCT = 5;

/** 失败阶梯的倍数上限（spec D6：最大 8×cooldownMs = 4 分钟） */
export const MAX_FAILED_MULTIPLIER = 8;

export function createGuardState(): GuardState {
	return { lastTriggerAt: null, ineffectiveStreak: 0, failedStreak: 0 };
}

/** 上下文用量投影（SDK `ContextUsage` 的结构子集） */
export interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
}

export function percentOf(tokens: number | null, contextWindow: number): number | null {
	if (tokens === null || !Number.isFinite(tokens) || !(contextWindow > 0)) return null;
	return (tokens / contextWindow) * 100;
}

/** 无效阶梯倍数：streak 0/1/2/3 → ×1/×2/×4/×8（streak 3 已不再触发，倍数只用于展示与日志） */
export function backoffMultiplier(streak: number): number {
	const clamped = Math.max(0, Math.min(Math.trunc(streak), MAX_INEFFECTIVE_STREAK));
	return 2 ** clamped;
}

/** 失败阶梯倍数：不封顶地递增，但倍数本身最多 ×8（spec D6） */
export function failedBackoffMultiplier(streak: number): number {
	const clamped = Math.max(0, Math.trunc(streak));
	return Math.min(2 ** clamped, MAX_FAILED_MULTIPLIER);
}

/** 冷却 = cooldownMs × max(两条阶梯的倍数) */
export function cooldownMsFor(state: GuardState, config: CompactionGuardConfig): number {
	const multiplier = Math.max(
		backoffMultiplier(state.ineffectiveStreak),
		failedBackoffMultiplier(state.failedStreak),
	);
	return config.cooldownMs * multiplier;
}

export type TriggerSkipReason =
	| "disabled"
	| "no-usage"
	| "no-window"
	| "below-threshold"
	| "cooldown"
	| "backoff";

export type TriggerDecision =
	| { trigger: true; tokens: number; contextWindow: number; percent: number; cooldownMs: number }
	| { trigger: false; reason: TriggerSkipReason; percent: number | null };

export interface TriggerInput {
	config: CompactionGuardConfig;
	/** `ctx.getContextUsage()` 的结果（undefined = 没有可用模型/窗口） */
	usage: ContextUsageLike | undefined;
	state: GuardState;
	now: number;
}

export function decideTrigger({ config, usage, state, now }: TriggerInput): TriggerDecision {
	if (!config.enabled) return { trigger: false, reason: "disabled", percent: null };
	// tokens=null 的两种真实情形：刚压缩完（还没发生成 usage）、模型缺失/窗口<=0
	if (!usage || usage.tokens === null) return { trigger: false, reason: "no-usage", percent: null };
	if (!(usage.contextWindow > 0)) return { trigger: false, reason: "no-window", percent: null };

	const percent = (usage.tokens / usage.contextWindow) * 100;
	if (percent < config.thresholdPct) return { trigger: false, reason: "below-threshold", percent };
	if (state.ineffectiveStreak >= MAX_INEFFECTIVE_STREAK)
		return { trigger: false, reason: "backoff", percent };

	const cooldownMs = cooldownMsFor(state, config);
	if (state.lastTriggerAt !== null && now - state.lastTriggerAt < cooldownMs) {
		return { trigger: false, reason: "cooldown", percent };
	}
	return { trigger: true, tokens: usage.tokens, contextWindow: usage.contextWindow, percent, cooldownMs };
}

/** 触发后记账（冷却起点） */
export function recordTrigger(state: GuardState, now: number): GuardState {
	return { ...state, lastTriggerAt: now };
}

/**
 * 摘要输入硬上限（spec D3）：
 * `summaryMaxOut = min(floor(0.8 × reserveTokens), model.maxTokens)`（与 SDK 摘要输出上限同口径）；
 * `hardCap = min(hardCapRatio × contextWindow, contextWindow − summaryMaxOut − 2048)`。
 * **不设绝对下限**（`max(…, 65536)` 在 200k 以下窗口会算出比窗口还大的上限）；`≤ 0` 时不介入。
 */
export function hardCapTokens(input: {
	contextWindow: number;
	reserveTokens: number;
	/** `<= 0` / 缺失 = 该模型没有单独的输出上限 */
	maxTokens?: number;
	hardCapRatio: number;
}): number {
	if (!(input.contextWindow > 0)) return 0;
	const maxTokens =
		input.maxTokens !== undefined && input.maxTokens > 0 ? input.maxTokens : Number.POSITIVE_INFINITY;
	const summaryMaxOut = Math.min(Math.floor(0.8 * input.reserveTokens), maxTokens);
	return Math.min(input.hardCapRatio * input.contextWindow, input.contextWindow - summaryMaxOut - 2048);
}

export interface OutcomeInput {
	/** 触发时的占窗口百分比 */
	percentBefore: number;
	/** 下一次拿到真实用量时的占窗口百分比 */
	percentNow: number;
	thresholdPct: number;
}

/**
 * 压缩效果判定（spec D6）：**仍 ≥ 阈值** 且 **下降 < 5 个百分点** → ineffective。
 * 注：只能在「压缩后第一次拿到非 null 用量」时算——刚压缩完 SDK 的 `getContextUsage().tokens` 恒为 null
 * （`agent-session.js` 的 `hasPostCompactionUsage` 门），所以判定落在下一次 `agent_settled`。
 */
export function judgeOutcome({ percentBefore, percentNow, thresholdPct }: OutcomeInput): {
	outcome: "ok" | "ineffective";
	dropPct: number;
} {
	const dropPct = percentBefore - percentNow;
	const ineffective = percentNow >= thresholdPct && dropPct < INEFFECTIVE_DROP_PCT;
	return { outcome: ineffective ? "ineffective" : "ok", dropPct };
}

/**
 * 记账（spec D6 两条阶梯）：
 * - `ok`：两边都清零（压缩成功且确实降下来了）；
 * - `ineffective`：压缩**成功**但没用 ⇒ `ineffectiveStreak++`（封顶 3 = 停手），失败阶梯清零（这次没失败）；
 * - `failed`：压缩本身失败 ⇒ `failedStreak++`（不封顶，倍数最多 ×8），**不动**无效阶梯
 *   （失败不是「压缩没用」的证据）。
 */
export function applyOutcome(state: GuardState, outcome: "ok" | "ineffective" | "failed"): GuardState {
	if (outcome === "ok") return { ...state, ineffectiveStreak: 0, failedStreak: 0 };
	if (outcome === "failed") return { ...state, failedStreak: state.failedStreak + 1 };
	return {
		...state,
		ineffectiveStreak: Math.min(state.ineffectiveStreak + 1, MAX_INEFFECTIVE_STREAK),
		failedStreak: 0,
	};
}
