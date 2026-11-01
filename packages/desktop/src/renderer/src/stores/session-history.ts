import { getExecutionApi } from "../environment-api";
import { installSessionBaseline } from "./session-baseline-install";
import {
	beginSessionBaseline,
	failSessionBaseline,
	forgetSessionBoundary,
	isCurrentSessionBaseline,
} from "./session-event-boundary";
import { setSessionHistoryLoadError } from "./transcript";

/** 权威首屏（完整模式为全历史）就绪与实时事件已到达是两种状态。 */
const ready = new Set<string>();
const acknowledged = new Map<string, string>();
const pending = new Map<string, { generation: number; isOpen: () => boolean; full?: boolean }>();
const inFlight = new Map<string, number>();
const openEpoch = new Map<string, number>();
let generation = 0;
export function historyOpenEpoch(sessionId: string): number {
	return openEpoch.get(sessionId) ?? 0;
}
export function isHistoryReady(sessionId: string): boolean {
	return ready.has(sessionId);
}
export function hasPendingSessionHistory(sessionId: string): boolean {
	return pending.has(sessionId);
}
export function clearSessionHistory(sessionId: string, options: { preserveHistoryAck?: boolean } = {}): void {
	forgetSessionBoundary(sessionId);
	openEpoch.set(sessionId, historyOpenEpoch(sessionId) + 1);
	ready.delete(sessionId);
	if (!options.preserveHistoryAck) acknowledged.delete(sessionId);
	pending.delete(sessionId);
}
/** 仅已安装的基线才能ACK，同一注册实例只确认一次；不等旧页，不从activeSession补猜。 */
export function finishSessionHistory(sessionId: string, hydrationToken?: string): void {
	pending.delete(sessionId);
	ready.add(sessionId);
	if (!hydrationToken || acknowledged.get(sessionId) === hydrationToken) return;
	acknowledged.set(sessionId, hydrationToken);
	void getExecutionApi(sessionId)
		.markSessionHistoryReady({ sessionId, hydrationToken })
		.catch((error: unknown) => {
			console.warn("会话历史就绪回执失败", error);
		});
}
export function deferSessionHistory(sessionId: string, isOpen: () => boolean): void {
	if (ready.has(sessionId)) return;
	pending.set(sessionId, { generation: ++generation, isOpen });
	void retrySessionHistory(sessionId);
}
export function reloadSessionHistory(sessionId: string, isOpen: () => boolean, full = false): Promise<void> {
	const current = pending.get(sessionId);
	if (current && Boolean(current.full) === full && inFlight.get(sessionId) === current.generation)
		return retrySessionHistory(sessionId);
	ready.delete(sessionId);
	pending.set(sessionId, { generation: ++generation, isOpen, full });
	return retrySessionHistory(sessionId);
}
export async function retrySessionHistory(sessionId: string): Promise<void> {
	const work = pending.get(sessionId);
	if (!work || inFlight.get(sessionId) === work.generation || !work.isOpen()) return;
	inFlight.set(sessionId, work.generation);
	const opening = historyOpenEpoch(sessionId);
	const token = beginSessionBaseline(sessionId);
	let stale = false;
	try {
		const baseline = await getExecutionApi(sessionId).getSessionBaseline({
			sessionId,
			imageMode: "references",
			historyTurns: work.full ? undefined : 4,
		});
		if (
			pending.get(sessionId)?.generation !== work.generation ||
			historyOpenEpoch(sessionId) !== opening ||
			!work.isOpen() ||
			!isCurrentSessionBaseline(sessionId, token)
		) {
			stale = true;
			return;
		}
		if (installSessionBaseline(sessionId, token, baseline))
			finishSessionHistory(sessionId, baseline.hydrationToken);
	} catch (error) {
		failSessionBaseline(sessionId, token);
		if (
			isCurrentSessionBaseline(sessionId, token) &&
			historyOpenEpoch(sessionId) === opening &&
			work.isOpen()
		)
			setSessionHistoryLoadError(sessionId, error);
		console.warn("会话历史补拉失败，等待下次重试", error);
	} finally {
		if (inFlight.get(sessionId) === work.generation) inFlight.delete(sessionId);
		if (stale && pending.has(sessionId)) void retrySessionHistory(sessionId);
	}
}
