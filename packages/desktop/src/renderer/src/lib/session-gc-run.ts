import { type EnvironmentRef, environmentEntityRef, sameEnvironment } from "@percho/shared";
import { pickUnloadCandidates, type SessionGcEntry, type SessionGcOpen } from "./session-gc";

/**
 * 内存策略的**一轮编排**（依赖全注入，故可脱离 React/IPC 单测）：
 *
 * 先由纯策略层算候选，再逐个确认（活跃/已关就跳过）并卸载；后端拒绝不算卸成功。
 * 频道订阅不影响会话驻留。
 */
export interface SessionGcRoundDeps {
	/** 当前打开集合 + 活跃会话（每轮现读；不能在轮内缓存） */
	getOpen: () => { activeSessionId: string | null; open: SessionGcOpen[] };
	/** 逐会话的 transcript 侧状态 */
	entryOf: (sessionId: string) => SessionGcEntry | undefined;
	/** 卸载一个会话（renderer `unloadSession`，带 intent="gc"） */
	unload: (sessionId: string) => Promise<{ closed: boolean }>;
	now: number;
	keep?: number;
	/** 日志（缺省 dev 打 console.debug，prod 静默） */
	log?: (message: string, ...args: unknown[]) => void;
}

export interface SessionGcRoundResult {
	skipped: null;
	/** 实际卸掉的会话（按卸载顺序） */
	unloaded: string[];
	/** 后端拒绝卸载的（closed=false；竞态：判定后又跑起来） */
	refused: string[];
}

const defaultLog = (message: string, ...args: unknown[]): void => {
	if (import.meta.env.DEV) console.debug(message, ...args);
};

export async function runSessionGcRound(deps: SessionGcRoundDeps): Promise<SessionGcRoundResult> {
	const log = deps.log ?? defaultLog;
	const state = deps.getOpen();
	const candidates = pickUnloadCandidates({
		activeSessionId: state.activeSessionId,
		open: state.open,
		entryOf: deps.entryOf,
		now: deps.now,
		keep: deps.keep,
	});

	const unloaded: string[] = [];
	const refused: string[] = [];
	for (const { sessionId, reason } of candidates) {
		// 卸载前再确认：前一个卸载可能等待，其间用户可能切过去或关掉会话
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

/** The existing policy runs independently for each environment. */
export async function runEnvironmentSessionGc(
	environments: readonly EnvironmentRef[],
	deps: SessionGcRoundDeps,
): Promise<SessionGcRoundResult[]> {
	return Promise.all(
		environments.map((environment) =>
			runSessionGcRound({
				...deps,
				getOpen: () => {
					const state = deps.getOpen();
					return {
						...state,
						open: state.open.filter((session) =>
							sameEnvironment(environmentEntityRef(session.sessionId).environment, environment),
						),
					};
				},
			}),
		),
	);
}
