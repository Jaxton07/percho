import { messagesToUIMessages } from "@percho/shared";
import { getExecutionApi } from "../environment-api";
import { useTranscriptStore } from "./transcript";

/** 历史就绪不是「收过实时事件」：打开中 agent 可抢先创建一个不完整 transcript。 */
const ready = new Set<string>();
const pending = new Map<string, { generation: number; isOpen: () => boolean }>();
const inFlight = new Map<string, number>();
let generation = 0;
const openEpoch = new Map<string, number>();

/** 关闭同 ID 会话后再次打开时，旧 IPC 响应不得落入新实例。 */
export function historyOpenEpoch(sessionId: string): number {
	return openEpoch.get(sessionId) ?? 0;
}

export function isHistoryReady(sessionId: string): boolean {
	return ready.has(sessionId);
}

export function hasPendingSessionHistory(sessionId: string): boolean {
	return pending.has(sessionId);
}

export function clearSessionHistory(sessionId: string): void {
	openEpoch.set(sessionId, historyOpenEpoch(sessionId) + 1);
	ready.delete(sessionId);
	pending.delete(sessionId);
	// 旧请求靠 generation 复核；新一轮可以独立发请求，不被旧实例的迟到 IPC 堵住。
}

/** 只在完整历史真正落到 UI 后发 ACK；失败的 ACK 由 backend 有限等待兜底。 */
export function finishSessionHistory(sessionId: string): void {
	pending.delete(sessionId);
	ready.add(sessionId);
	void getExecutionApi(sessionId)
		.markSessionHistoryReady({ sessionId })
		.catch((error: unknown) => {
			console.warn("会话历史就绪回执失败", error);
		});
}

/** 活跃 run 时不能用静态快照覆盖流式态，记录待补历史，idle / settled 后拉最新快照。 */
export function deferSessionHistory(sessionId: string, isOpen: () => boolean): void {
	if (ready.has(sessionId)) return;
	pending.set(sessionId, { generation: ++generation, isOpen });
	void retrySessionHistory(sessionId);
}

export async function retrySessionHistory(sessionId: string): Promise<void> {
	const work = pending.get(sessionId);
	if (!work || inFlight.get(sessionId) === work.generation || !work.isOpen()) return;
	if (useTranscriptStore.getState().bySession[sessionId]?.agentActive) return;
	inFlight.set(sessionId, work.generation);
	let stale = false;
	try {
		// 快照必须重新读取：先前被丢弃的那一份可能不含刚结束的 run。
		const before = useTranscriptStore.getState().bySession[sessionId];
		const history = await getExecutionApi(sessionId).getSessionMessages({ sessionId });
		const after = useTranscriptStore.getState().bySession[sessionId];
		if (pending.get(sessionId)?.generation !== work.generation || !work.isOpen()) {
			stale = true;
			return;
		}
		if (after?.agentActive || before !== after) {
			stale = !after?.agentActive; // 刚结束的新事件已进 UI：重新取一份，不复用旧快照
			return;
		}
		useTranscriptStore.getState().loadHistory(sessionId, messagesToUIMessages(history));
		finishSessionHistory(sessionId);
	} catch (error) {
		console.warn("会话历史补拉失败，等待下次重试", error);
	} finally {
		if (inFlight.get(sessionId) === work.generation) inFlight.delete(sessionId);
		if (stale && pending.has(sessionId)) void retrySessionHistory(sessionId);
	}
}
