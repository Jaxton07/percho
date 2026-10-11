/**
 * 压缩护栏（内置扩展）：把「压缩触发线」百分比化 + 让「摘要请求体积」有界。
 *
 * 模块分层（plan §新增模块）：
 * - types / estimate / guard / bound：**纯函数核心**，零 SDK / 零仓库 import —— 单测不用 mock SDK，
 *   离线重放脚本（scripts/replay-compaction-bound.mts）import 同一份实现做同构验证（单一事实源）
 * - config：`settings.json` 的 `compactionGuard` 段（内部调参面，不进设置页）
 * - extension：InlineExtension 接线（agent_settled 触发 / session_before_compact 有界化 / 收尾观测）
 *
 * 行为规则唯一权威：.local/agent-work/spec/compaction-bounded.md（spec D1–D8 + §6 A1–A9）。
 */

export { type BoundOptions, boundMessages, capActive } from "./bound";
export { readCompactionGuardConfig } from "./config";
export { estimateTokens } from "./estimate";
export {
	type CompactionGuardExtensionOptions,
	makeCompactionGuardExtension,
	sdkSerializer,
} from "./extension";
export {
	applyOutcome,
	backoffMultiplier,
	type ContextUsageLike,
	cooldownMsFor,
	createGuardState,
	decideTrigger,
	type GuardState,
	INEFFECTIVE_DROP_PCT,
	judgeOutcome,
	MAX_INEFFECTIVE_STREAK,
	percentOf,
	recordTrigger,
	type TriggerDecision,
	type TriggerInput,
	type TriggerSkipReason,
} from "./guard";
export {
	type CompactionBoundResult,
	type CompactionBoundStats,
	type CompactionGuardConfig,
	type CompactionGuardObservation,
	type CompactionGuardOutcome,
	type CompactionGuardPhase,
	type CompactionGuardReason,
	DEFAULT_COMPACTION_GUARD_CONFIG,
	type GuardMessage,
} from "./types";
