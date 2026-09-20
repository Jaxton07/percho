import { pickUnloadCandidates, type SessionGcEntry, type SessionGcOpen } from "./session-gc";

/**
 * 内存策略的**一轮编排**（依赖全注入，故可脱离 React/IPC 单测）：
 *
 * 1. 先拉一次「有有效频道订阅的已加载会话 ID」快照（订阅会话不能被自动卸载，spec §6.2）；
 * 2. 把快照映射进每个会话的 `hasChannelSubscriptions`，交给纯策略层算候选（lib/session-gc.ts）；
 * 3. 逐个再确认（活跃/已关就跳过）后调 `unload`，后端拒绝（closed=false）不算卸成功。
 *
 * **fail-safe 语义**：快照拉不到 = 保护范围未知 → **整轮跳过**，一个都不卸。宁可多留一点内存，
 * 也不能把未知当「无人订阅」而卸掉正在等人的订阅会话；下一轮（store 变化或 20s tick）自然重试。
 * 注意不能退化成「让 backend 拒绝一次」：那会把 GC 变成每会话一次无效 IPC，且策略层判定先于守卫。
 */
export interface SessionGcRoundDeps {
	/** 当前打开集合 + 活跃会话（每轮现读；不能在轮内缓存） */
	getOpen: () => { activeSessionId: string | null; open: SessionGcOpen[] };
	/** 逐会话的 transcript 侧状态 */
	entryOf: (sessionId: string) => SessionGcEntry | undefined;
	/** 批量取有有效频道订阅的已加载会话 ID（IPC；抛错 = 本轮跳过） */
	listSubscriptionSessionIds: () => Promise<string[]>;
	/** 卸载一个会话（renderer `unloadSession`，带 intent="gc"） */
	unload: (sessionId: string) => Promise<{ closed: boolean }>;
	now: number;
	keep?: number;
	/** 日志（缺省 dev 打 console.debug，prod 静默） */
	log?: (message: string, ...args: unknown[]) => void;
}

export interface SessionGcRoundResult {
	/** 非 null = 本轮整体跳过且原因在此 */
	skipped: "subscription-snapshot-failed" | null;
	/** 实际卸掉的会话（按卸载顺序） */
	unloaded: string[];
	/** 后端拒绝卸载的（closed=false；竞态：判定后又跑起来/刚订阅） */
	refused: string[];
}

const defaultLog = (message: string, ...args: unknown[]): void => {
	if (import.meta.env.DEV) console.debug(message, ...args);
};

export async function runSessionGcRound(deps: SessionGcRoundDeps): Promise<SessionGcRoundResult> {
	const log = deps.log ?? defaultLog;
	let subscribedIds: Set<string>;
	try {
		subscribedIds = new Set(await deps.listSubscriptionSessionIds());
	} catch (error) {
		log("[session-gc] 跳过本轮：频道订阅快照获取失败", error);
		return { skipped: "subscription-snapshot-failed", unloaded: [], refused: [] };
	}

	const state = deps.getOpen();
	const candidates = pickUnloadCandidates({
		activeSessionId: state.activeSessionId,
		open: state.open.map((item) => ({
			...item,
			hasChannelSubscriptions: subscribedIds.has(item.sessionId),
		})),
		entryOf: deps.entryOf,
		now: deps.now,
		keep: deps.keep,
	});

	const unloaded: string[] = [];
	const refused: string[] = [];
	for (const { sessionId, reason } of candidates) {
		// 卸载前再确认：判定与执行之间有 await（快照），其间用户可能切过去/关掉/又跑起来
		const latest = deps.getOpen();
		if (latest.activeSessionId === sessionId) continue;
		if (!latest.open.some((item) => item.sessionId === sessionId)) continue;
		const { closed } = await deps.unload(sessionId);
		if (closed) {
			unloaded.push(sessionId);
			log("[session-gc] unload", sessionId, `reason=${reason}`);
		} else {
			refused.push(sessionId);
			log("[session-gc] skipped", sessionId, `reason=${reason} refused-by-backend`);
		}
	}
	return { skipped: null, unloaded, refused };
}
