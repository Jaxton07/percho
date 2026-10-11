/**
 * 压缩护栏（compaction guard）核心类型。
 *
 * 约束（plan §新增模块）：本文件零 SDK、零仓库 import —— 单测无需 mock SDK，
 * 离线重放脚本（scripts/replay-compaction-bound.mts）可 import 同一份决策/有界逻辑做同构验证。
 * 消息用**结构投影类型**（与 SDK `AgentMessage` 兼容，经 `unknown` 收窄），与蒸发核心同做法。
 *
 * 行为规则唯一权威：.local/agent-work/spec/compaction-bounded.md（D1–D8 + §6 A1–A9）。
 */

// ---------- 配置（内部调参面，不进设置页；spec D7） ----------

export interface CompactionGuardConfig {
	/** 逃生舱（不暴露 UI）：false 时整体关掉自研触发（SDK 默认路径完全不变） */
	enabled: boolean;
	/** 触发线（%，分母 = model.contextWindow），默认 80 */
	thresholdPct: number;
	/** 摘要输入上限比例（× 窗口），默认 0.5 */
	hardCapRatio: number;
	/** 保护区：最近 N 个用户轮不降级，默认 2 */
	protectTurns: number;
	/** 降级后单条 tool result 文本上限（字符），默认 300 */
	toolResultChars: number;
	/** 冷却（ms，自上次主动触发起算），默认 30000 */
	cooldownMs: number;
}

/** 默认值 = 产品行为（改默认值算行为变更，要过 review；spec D7） */
export const DEFAULT_COMPACTION_GUARD_CONFIG: CompactionGuardConfig = {
	enabled: true,
	thresholdPct: 80,
	hardCapRatio: 0.5,
	protectTurns: 2,
	toolResultChars: 300,
	cooldownMs: 30_000,
};

// ---------- 可观测（trace_custom "compaction_guard" 行；spec D6） ----------

/** 体积测量方式（spec D3 两段式）：`cheap` = 逐条估算求和（初判），`exact` = 整体序列化（收敛口径） */
export type CompactionBoundMeasure = "cheap" | "exact";

/** `percent` 的来源（spec D6）：真实 wire usage / 尾部估算 */
export type CompactionPercentBasis = "usage" | "estimate";

/** 三个相位：触发判定 / 摘要输入有界化 / 压缩收尾与效果判定 */
export type CompactionGuardPhase = "trigger" | "bound" | "settled";

/** 压缩原因（SDK 字段直传）+ 自研触发（threshold-pct） */
export type CompactionGuardReason = "threshold-pct" | "manual" | "threshold" | "overflow";

export type CompactionGuardOutcome =
	| "ok"
	| "ineffective"
	| "failed"
	| "aborted"
	| "skipped"
	| "hook-error"
	| "cap-unreachable";

/** 观测行（字段表 = spec D6；缺项即不适用，不写 null 以外的占位） */
export interface CompactionGuardObservation {
	phase: CompactionGuardPhase;
	reason?: CompactionGuardReason;
	/** 触发/收尾相位：占窗口百分比（tokens 未知时省略） */
	percent?: number;
	/** 触发/收尾相位：percent 来自真实 usage 还是尾部估算（spec D6） */
	percentBasis?: CompactionPercentBasis;
	tokensBefore?: number;
	contextWindow?: number;
	/** bound / settled 相位：有界化前后估算（settled 用 SDK 的真实 tokens） */
	estimatedBefore?: number;
	estimatedAfter?: number;
	cap?: number;
	/** bound 相位：体积是逐条估算求和还是整体序列化量出来的（spec D3 两段式） */
	measure?: CompactionBoundMeasure;
	/** bound 相位：层 2 迭代轮数 */
	capRounds?: number;
	droppedMessages?: number;
	degradedMessages?: number;
	splitTurn?: boolean;
	/** sdk = 非自研触发（手动/SDK 阈值/溢出恢复）的压缩也照记一行 */
	source?: "guard" | "sdk";
	outcome?: CompactionGuardOutcome;
	/** 失败原因原文 / 降级说明（不截断，便于 grep 反查） */
	detail?: string;
}

// ---------- 结构投影的消息类型（bound.ts 零 SDK import 的前提） ----------

export interface GuardContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface GuardMessage {
	role: string;
	content: string | GuardContentBlock[];
	timestamp?: number;
	[key: string]: unknown;
}

// ---------- 有界化结果 ----------

export interface CompactionBoundStats {
	/** 输入消息条数（两份请求各自一份） */
	messageCount: number;
	/** 被层 1 降级的消息条数（含二次收紧的） */
	degradedMessages: number;
	/** 层 2 丢掉的最旧消息条数 */
	droppedMessages: number;
	/** 有界化前估算（**逐条口径**：便宜，只作诊断） */
	estimatedBefore: number;
	/** 有界化后估算（口径见 `measure`；`exact` 时即 A3 断言的「整体估算」） */
	estimatedAfter: number;
	/** 生效上限（token）；`<= 0` 表示不介入 */
	cap: number;
	/** 整体估算是否 ≤ cap（cap 不介入时恒 true） */
	withinCap: boolean;
	/** 自身估算就超 cap 的单条消息数（残余风险，spec §5） */
	oversizedMessages: number;
	/** 体积是用哪档口径量出来的（spec D3 两段式） */
	measure: CompactionBoundMeasure;
	/** 层 2 迭代轮数（0 = 未触发） */
	capRounds: number;
}

export interface CompactionBoundResult {
	/** 新数组 + 新消息对象；输入绝不被就地修改（spec §2 共享引用） */
	messages: GuardMessage[];
	stats: CompactionBoundStats;
}
