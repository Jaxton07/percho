import type { PermissionMode } from "@percho/shared";

/**
 * 会话内存驻留策略（**纯函数**：不 import React、不调 IPC、不读时钟——`now` 由调用方传入）。
 *
 * 机制一句话：`保留集合 = { 活跃会话 } ∪ { 受保护会话 } ∪ { 最近使用的至多 K 个空闲会话 }`，
 * 其余由接线层（`lib/use-session-gc.ts`）调 `unloadSession` 卸掉。
 *
 * 为什么有一条条保护条件：卸载 = 关后端会话 + 清渲染层 transcript，凡是「权威状态只活在
 * 这次进程里的」一律不能卸（跑了会中断、排队的消息在后端内存里、权限模式不落盘、0 消息会话
 * 连会话文件都还没有）。依据见 spec `session-memory-policy.md` §3 决策 3 与阶段 0 审计。
 *
 * 顺序语义（单测逐条钉住）：① 先剔除受保护 / draft / 活跃 / `freshMs` 内用过的；
 * ② 剩余按 `lastUsedAt` **最久未用在前**排序；③ 保留前 `keep` 个最新的，其余是候选；
 * ④ 某会话 `now - lastUsedAt > idleTimeoutMs` 时，即使还在 keep 名额内也照样候选（兜底超时）。
 */

/** transcript 里与本策略有关的子集（`useTranscriptStore.bySession[sid]`） */
export interface SessionGcEntry {
	/** agent 正在跑（含等审批：审批阻塞发生在 run 内部，isStreaming 两态都为 true） */
	agentActive: boolean;
	/** 未决权限请求队列 */
	pendingPermissions: unknown[];
	/** 未决扩展对话框（等用户应答） */
	pendingDialogs: unknown[];
	/** 完成未读（绿点）：不卸，否则用户回来时线索没了 */
	unseenCompletion: boolean;
	/** 正在压缩上下文 */
	compacting: boolean;
	/** 排队跟发（**只活在后端会话内存里、不落盘**，卸载即丢） */
	followUpQueue: string[];
	/**
	 * transcript 里已知的消息条数。与 `item.messageCount`（磁盘元数据，只在打开时读一次）**取较大值**判断
	 * 「有没有会话文件」——本次进程内新建的会话 meta 恒为 0（store 不随流式事件更新），只看 meta 会把它
	 * 永远当成空会话而永不卸载（阶段 3 真机验收抓到的真 bug）。
	 */
	messageCount: number;
}

/** `sessions` store 里的一个打开中的会话（会话侧字段） */
export interface SessionGcOpen {
	sessionId: string;
	/** 最近使用时刻（切会话/打开/新建时打点；毫秒） */
	lastUsedAt: number;
	/** draft（还没落盘的内存 tab） */
	isDraft: boolean;
	/** 权限模式：`sessions.permissionModes[sid] ?? "default"` */
	permissionMode: PermissionMode;
	/** 消息条数（磁盘元数据，打开时读一次）：与 transcript 条数取大值判断「有没有会话文件」 */
	messageCount: number;
}

export interface SessionGcInput {
	activeSessionId: string | null;
	/** 当前在内存里的会话（= sessions store 的 sessions） */
	open: SessionGcOpen[];
	/** 取 transcript 侧状态；没装载过的会话返回 undefined（等同空闲） */
	entryOf: (sessionId: string) => SessionGcEntry | undefined;
	now: number;
	/** 空闲热会话保留数 */
	keep?: number;
	/** 刚用过的不卸（防「刚发送、run 未起」竞态） */
	freshMs?: number;
	/** 切走多久后兜底卸（避免长尾全留着） */
	idleTimeoutMs?: number;
}

export interface UnloadCandidate {
	sessionId: string;
	reason: "over-limit" | "idle-timeout";
}

export const GC_DEFAULTS = {
	keep: 3,
	/**
	 * 刚用过的不卸（防「已发送、run 未起」的竞态）。3s 足够盖住「发送 → agent_start」这段
	 * （实测不到 1s），同时把「连开多个会话」的峰值窗口压到可接受：10s 时十连开会堆到 ~+370MB
	 * 才回落，3s 后被新开的会话自然触发回收（见 REVIEW 10:37 裁决）。
	 */
	freshMs: 3_000,
	idleTimeoutMs: 300_000,
} as const;

/**
 * 保护判定（受保护会话**不占 K 名额**、永不卸载）。
 * 会话侧三条：draft / 0 消息 / 权限模式非 default；transcript 侧六条见 `SessionGcEntry`。
 * 导出给单测与接线层复用（接线层算候选时无需重复这套判断）。
 */
export function isProtected(item: SessionGcOpen, entry: SessionGcEntry | undefined): boolean {
	if (item.isDraft) return true;
	// 0 消息会话还没有会话文件（SDK 只在追加 entry 时才建文件）：磁盘历史里查不到它，
	// 卸掉 = 会话条目从 UI 消失、用户刚选的模型/档位丢失（审计实测）。
	// 判据取「磁盘 meta」与「transcript 实时条数」的较大值 —— 只信 meta 会把本次进程内
	// 新建的会话（meta 恒 0）永远保护住，策略等于失效。
	if (item.messageCount === 0 && (entry?.messageCount ?? 0) === 0) return true;
	// 权限模式权威源在后端会话内存且不落盘（重启归零是有意的安全设计）：卸掉会静默降级回默认
	if (item.permissionMode !== "default") return true;
	if (!entry) return false;
	return (
		entry.agentActive ||
		entry.compacting ||
		entry.unseenCompletion ||
		entry.pendingPermissions.length > 0 ||
		entry.pendingDialogs.length > 0 ||
		entry.followUpQueue.length > 0
	);
}

/** 算出该卸哪些（返回顺序 = 卸载顺序：最久未用在前；空数组 = 什么都不用卸） */
export function pickUnloadCandidates(input: SessionGcInput): UnloadCandidate[] {
	const keep = input.keep ?? GC_DEFAULTS.keep;
	const freshMs = input.freshMs ?? GC_DEFAULTS.freshMs;
	const idleTimeoutMs = input.idleTimeoutMs ?? GC_DEFAULTS.idleTimeoutMs;

	const idle = input.open
		.filter(
			(item) =>
				item.sessionId !== input.activeSessionId &&
				!isProtected(item, input.entryOf(item.sessionId)) &&
				// 刚用过：可能是「已发送、run 还没起来」，这一瞬卸了就把请求吞了
				input.now - item.lastUsedAt > freshMs,
		)
		.sort((a, b) => a.lastUsedAt - b.lastUsedAt);

	const overLimitCount = Math.max(0, idle.length - Math.max(0, keep));
	return [
		...idle
			.slice(0, overLimitCount)
			.map((item): UnloadCandidate => ({ sessionId: item.sessionId, reason: "over-limit" })),
		// 兜底超时：keep 名额之内但已经晾太久的，也别留着（避免长尾全驻留）
		...idle
			.slice(overLimitCount)
			.filter((item) => input.now - item.lastUsedAt > idleTimeoutMs)
			.map((item): UnloadCandidate => ({ sessionId: item.sessionId, reason: "idle-timeout" })),
	];
}
