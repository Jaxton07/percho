import { useEffect } from "react";
import { isDraftSessionId, useSessionsStore } from "../stores/sessions";
import { useTranscriptStore } from "../stores/transcript";
import { pickUnloadCandidates, type SessionGcEntry } from "./session-gc";

/**
 * 会话内存策略接线层：把 `lib/session-gc.ts` 的纯判定接到 store 上（判定逻辑全在那边，这里只订阅与执行）。
 *
 * **为什么不订阅 transcript**：`bySession` 每来一个 token 就变一次，订阅它等于每个 token 白跑一轮判定。
 * 改为「挂载跑一次 + 60s 兜底 tick + 只订阅 sessions/activeSessionId」，回调里一律 `getState()` 现读
 * （60s tick 也保证 `idleTimeoutMs` 那条时间规则会随真实时间推进而生效）。
 *
 * 空闲热会话保留数（K=3，用户拍板）。想调体验改这里。
 */
const KEEP = 3;
/** 兜底 tick 间隔（也是「晾过 idleTimeoutMs 才卸」这条规则的最坏延迟） */
const TICK_MS = 60_000;

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
				const state = useSessionsStore.getState();
				const candidates = pickUnloadCandidates({
					activeSessionId: state.activeSessionId,
					open: state.sessions.map((session) => ({
						sessionId: session.sessionId,
						// 缺打点理论不可达（每个进 sessions 的路径都打点）；真缺了当「最久未用」处理
						lastUsedAt: state.lastUsedAt[session.sessionId] ?? 0,
						isDraft: isDraftSessionId(session.sessionId),
						permissionMode: state.permissionModes[session.sessionId] ?? "default",
						// 磁盘元数据（打开时读一次；本次进程内新建的会话恒为 0）：与 transcript 实时条数
						// 一起交给纯层判「有没有会话文件」，见 lib/session-gc.ts 的 isProtected
						messageCount: session.messageCount,
					})),
					entryOf,
					now: Date.now(),
					keep: KEEP,
				});

				for (const { sessionId, reason } of candidates) {
					// 算完候选到真正卸载之间，用户可能正好切过来、会话也可能已被关掉 → 逐个再确认一次
					const latest = useSessionsStore.getState();
					if (latest.activeSessionId === sessionId) continue;
					if (!latest.sessions.some((s) => s.sessionId === sessionId)) continue;
					// 日志打在**成功之后**：后端在跑会拒绝（closed=false），打在前面会误报「已卸载」
					const { closed } = await latest.unloadSession(sessionId);
					if (import.meta.env.DEV) {
						if (closed) console.debug("[session-gc] unload", sessionId, `reason=${reason}`);
						else console.debug("[session-gc] skipped", sessionId, `reason=${reason} refused-by-backend`);
					}
				}
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
