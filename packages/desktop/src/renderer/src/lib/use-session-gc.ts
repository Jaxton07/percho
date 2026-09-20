import { useEffect } from "react";
import { getPi } from "../api";
import { isDraftSessionId, useSessionsStore } from "../stores/sessions";
import { useTranscriptStore } from "../stores/transcript";
import type { SessionGcEntry } from "./session-gc";
import { runSessionGcRound } from "./session-gc-run";

/**
 * 会话内存策略接线层：把 store/IPC 接到 `lib/session-gc-run.ts` 的一轮编排上
 * （判定与 fail-safe 语义全在那边，这里只订阅与时序）。
 *
 * **为什么不订阅 transcript**：`bySession` 每来一个 token 就变一次，订阅它等于每个 token 白跑一轮判定。
 * 改为「挂载跑一次 + 20s 兜底 tick + 只订阅 sessions/activeSessionId」，回调里一律 `getState()` 现读
 * （tick 也保证 `idleTimeoutMs` 那条时间规则会随真实时间推进而生效）。
 *
 * 空闲热会话保留数（K=3，用户拍板）。想调体验改这里。
 */
const KEEP = 3;
/** 兜底 tick 间隔（也是「晾过 idleTimeoutMs 才卸」这条规则的最坏延迟）。
 * 20s 而非 60s：爆发期的会话变化判定会被 `freshMs` 挡住，之后只能等 tick —— 60s 时实测最坏
 * 53s 才回收；20s 让「浏览完」最多 20s 收敛，代价只是每 20s 读一次 state（可忽略）。 */
const TICK_MS = 20_000;

function entryOf(sessionId: string): SessionGcEntry | undefined {
	const entry = useTranscriptStore.getState().bySession[sessionId];
	if (!entry) return undefined;
	return {
		agentActive: entry.agentActive,
		pendingPermissions: entry.pendingPermissions,
		pendingDialogs: entry.pendingDialogs,
		unseenCompletion: entry.unseenCompletion,
		compacting: entry.compacting,
		followUpQueue: entry.followUpQueue,
		messageCount: entry.messages.length,
	};
}

export function useSessionGc(): void {
	useEffect(() => {
		// 幂等：上一轮还有 await 没走完就不重入（tick 与会话切换可能撞在一起）
		let running = false;

		const run = async (): Promise<void> => {
			if (running) return;
			running = true;
			try {
				await runSessionGcRound({
					getOpen: () => {
						const state = useSessionsStore.getState();
						return {
							activeSessionId: state.activeSessionId,
							open: state.sessions.map((session) => ({
								sessionId: session.sessionId,
								// 缺打点理论不可达（每个进 sessions 的路径都打点）；真缺了当「最久未用」处理
								lastUsedAt: state.lastUsedAt[session.sessionId] ?? 0,
								isDraft: isDraftSessionId(session.sessionId),
								// 磁盘元数据（打开时读一次；本次进程内新建的会话恒为 0）：与 transcript 实时条数
								// 一起交给纯层判「有没有会话文件」，见 lib/session-gc.ts 的 isProtected；
								// hasChannelSubscriptions 由本轮编排从 backend 快照映射进来
								messageCount: session.messageCount,
							})),
						};
					},
					entryOf,
					listSubscriptionSessionIds: () => getPi().getChannelSubscriptionSessionIds(),
					unload: (sessionId) => useSessionsStore.getState().unloadSession(sessionId),
					now: Date.now(),
					keep: KEEP,
				});
			} finally {
				running = false;
			}
		};

		void run();
		const timer = window.setInterval(() => void run(), TICK_MS);
		// 只订阅「打开集合 / 活跃会话」两个原始引用（切会话、开关会话即时判定）
		const unsubscribe = useSessionsStore.subscribe((state, prev) => {
			if (state.sessions !== prev.sessions || state.activeSessionId !== prev.activeSessionId) void run();
		});
		return () => {
			window.clearInterval(timer);
			unsubscribe();
		};
	}, []);
}
