/**
 * 上下文蒸发（Context Evaporation）核心类型。
 *
 * 约束（arch §1）：本文件零 SDK、零仓库 import（除同目录 estimate/evaporate 彼此）——
 * 单测无需 mock SDK，replay 脚本（scripts/replay-evaporation.mts --core）可直接 import
 * 同一份决策逻辑做离线/在线同构验证。wire 消息用结构投影类型，与 SDK AgentMessage
 * 兼容、经 unknown 收窄（acp-context/bridge.ts 同款手法）。
 *
 * 行为规则唯一权威：.local/agent-work/spec/context-evaporation.md（spec v2 §3-§7）。
 */

// ---------- 配置 ----------

/** 四级水位线（%，分母 = effectiveWindow = min(model.contextWindow, budgetTokens)） */
export interface EvapTiers {
	/** Tier 1 snip：到龄工具输出头尾截断 + 用户代码块折叠 */
	snip: number;
	/** Tier 2 prune：升级为占位 stub */
	prune: number;
	/** Tier 3 summarize：v1 = 无动作，SDK 原生压缩兜底 */
	summarize: number;
}

export interface EvapConfig {
	tiers: EvapTiers;
	/** 全局预算（用户级，非 per-model）：effectiveWindow = min(model.contextWindow, budgetTokens) */
	budgetTokens: number;
	/** 保护区 token 数（wire 尾部向回累计，按 token 不按条数） */
	protectionTokens: number;
	/** command/external 类 Tier 1 头尾截断行数（read 类固定 10/5，见 evaporate.ts 常量） */
	headLines: number;
	tailLines: number;
	/** Tier 1 截断的输出字节阈值；Tier 2 不受此限（editWrite 的 Tier 2 大 diff 判定也用它） */
	headTailThreshold: number;
	/** Tier 2 stub 范围：all / gt4k */
	tier2Scope: "all" | "gt4k";
	/** Tier 2 截断老的 assistant 文本（replay 否决：无体积收益、cacheWrite 反升，保持关） */
	trimAssistantText: boolean;
	/** 受保护工具（输出任何水位不动） */
	protectedTools: string[];
}

/**
 * 默认配置 = 2026-08-26 方案 B 定稿（发起人裁决）：256K 基准，绝对触发点 154K/218K/243K。
 * 依据：.local/agent-work/plan/context-evaporation.md §2（160K/256K budget 补跑）。
 */
export const DEFAULT_EVAP_CONFIG: EvapConfig = {
	tiers: { snip: 60, prune: 85, summarize: 95 },
	budgetTokens: 262144,
	protectionTokens: 8000,
	headLines: 15,
	tailLines: 25,
	headTailThreshold: 4096,
	tier2Scope: "all",
	trimAssistantText: false,
	protectedTools: ["todo"],
};

// ---------- 决策状态 ----------

/**
 * 决策级别，只升不降（KV cache 第一约束，spec §4）：
 * - snip = Tier 1 形态（工具输出头尾截断 / 用户文本代码块折叠 / assistant 前两句——仅 trimAssistantText）
 * - stub = Tier 2 占位符
 * stub 内容 = part 自身的纯函数，Map 只记「决策到哪一级」，不存替换文本。
 */
export type EvapLevel = "snip" | "stub";

export interface EvapDecision {
	level: EvapLevel;
}

/** part 身份 key（arch §4.1，全部为 part 内容/元数据的纯函数）：
 *  - toolResult 文本：`tr:<toolCallId>`
 *  - toolResult 内第 i 个图片 block：`tr:<toolCallId>:img<i>`
 *  - user 文本（含代码块折叠）：`h:<sha256(text) 前 12 hex>`
 *  - user 图片：`h:img:<data 长度>:<前 64 字符指纹>`（碰撞代价 = 两同图共享决策，方向一致无害）
 *  - assistant 文本（仅 trimAssistantText 路径）：`ha:<sha256(text) 前 12 hex>` */
export type EvapDecisionMap = Map<string, EvapDecision>;

/** 蒸发状态（扩展工厂闭包内持有，per-session；session_start 全新 / session_compact 重置）。
 * 注：不做消息级估算缓存——SDK emitContext 每次调用 structuredClone，对象身份跨调用
 * 不稳定，缓存零收益（2026-08-26 实施决策，见 IMPL-NOTES）；全量扫描成本毫秒级可忽略 */
export interface EvapState {
	decisions: EvapDecisionMap;
}

export function createEvapState(): EvapState {
	return { decisions: new Map() };
}

// ---------- 可观测 ----------

/** 一次 context 钩子调用的批次信息（arch §8 字段表；P2 log / P3 trace 载荷） */
export interface EvapBatchInfo {
	/** 本轮水位档：0-3（3 = ≥ summarize 线，v1 无动作仅记录） */
	tier: number;
	/** 本轮输入水位 %（usageTokens 优先，否则内部估算） */
	usagePct: number;
	/** 动作后的 wire 内部估算 token（protection/批停机同源口径） */
	wireEstTokens: number;
	/** 本轮新 snip/fold（含 trim）数 */
	snipped: number;
	/** 本轮新 stub 数 */
	pruned: number;
	/** 全 wire 累计节省估算（Σ tFull − 当前） */
	savedEstTokens: number;
	/** 已决策 part 本轮直接复用数 */
	cacheHits: number;
	mapSize: number;
}

// ---------- wire 结构投影（与 SDK AgentMessage 兼容，经 unknown 收窄） ----------

export interface EvapTextBlock {
	type: "text";
	text: string;
	/** 替换正文时随字节一并失效（签名对应原文） */
	textSignature?: string;
	[k: string]: unknown;
}

export interface EvapImageBlock {
	type: "image";
	data: string;
	mimeType: string;
	[k: string]: unknown;
}

export interface EvapUserMessage {
	role: "user";
	content: string | (EvapTextBlock | EvapImageBlock)[];
	[k: string]: unknown;
}

export interface EvapAssistantMessage {
	role: "assistant";
	content: unknown[];
	[k: string]: unknown;
}

export interface EvapToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: unknown[];
	isError?: boolean;
	details?: unknown;
	[k: string]: unknown;
}

/** wire 消息：只窄化到蒸发关心的形态，其余（custom/bashExecution/branchSummary/compactionSummary
 *  等）落在兜底成员上——一律不碰、不计 token（与 replay 口径一致） */
export type EvapWireMessage =
	| EvapUserMessage
	| EvapAssistantMessage
	| EvapToolResultMessage
	| {
			role: string;
			[k: string]: unknown;
	  };

// ---------- part 模型（evaporate 内部 + replay inspectParts 视图） ----------

export type EvapClass =
	| "userText"
	| "image"
	| "assistantText"
	| "toolCall"
	| "read"
	| "command"
	| "external"
	| "editWrite"
	| "protected";

/** part 在消息内的定位（渲染替换用；toolCall 仅占位不参与决策） */
export type EvapPartKind =
	| "userString"
	| "userText"
	| "userImage"
	| "trText"
	| "trImage"
	| "assistantText"
	| "toolCall";

/** part 静态信息：内容与元数据的纯函数（不含轮次/时间等会话状态，spec §4.1） */
export interface EvapPartInfo {
	cls: EvapClass;
	kind: EvapPartKind;
	key: string;
	messageIndex: number;
	/** content 数组内下标；userString（content 为 string）为 -1 */
	blockIndex: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** compactionProtected 标记位（业务侧显式钉住；v1 无产生方，仅检查点） */
	pinned?: boolean;
	/** 原文（toolResult 拼接文本 / user / assistant 文本） */
	text?: string;
	/** 各状态 token 估算（不适用时 = tFull）；口径与 replay 逐字节对齐 */
	tFull: number;
	tSnip: number;
	tStub: number;
	tFold: number;
	tTrim: number;
	/** Tier 2 可 stub 的类（运行时再按 tier2Scope/bytes 细判） */
	stubbable: boolean;
	bytes: number;
}

/** replay --core 检视视图（离线指标用；live 不消费） */
export interface EvapPartView {
	cls: EvapClass;
	key: string;
	toolCallId?: string;
	isError?: boolean;
	/** 当前生效级别（userText 的 snip = fold；assistantText 的 snip = trim） */
	level: EvapLevel | "full";
	/** 当前状态 token */
	tokens: number;
	tFull: number;
	/** 以下供 replay --core 冷启动探针复用（replay simSession 同款判定需要） */
	tSnip: number;
	tStub: number;
	bytes: number;
	messageIndex: number;
}
