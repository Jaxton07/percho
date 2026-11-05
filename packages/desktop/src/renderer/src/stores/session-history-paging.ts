import type { SessionHistoryPage, SessionHistoryWindow, SessionNavigation } from "@percho/shared";
import { getExecutionApi } from "../environment-api";
import { isSessionSynchronizing } from "./session-event-boundary";
import { historyOpenEpoch } from "./session-history";
import { useTranscriptStore } from "./transcript";

const inFlight = new Map<
	string,
	{
		history: SessionHistoryWindow;
		cursor: string;
		opening: number;
		promise: Promise<unknown>;
	}
>();

function sameSource(a: SessionHistoryWindow | undefined, b: SessionHistoryWindow): boolean {
	return (
		a?.generation === b.generation &&
		a.sourceVersion === b.sourceVersion &&
		a.hydrationToken === b.hydrationToken
	);
}

function isCurrent(
	sessionId: string,
	opening: number,
	history: SessionHistoryWindow,
	cursor?: string,
): boolean {
	const current = useTranscriptStore.getState().bySession[sessionId]?.history;
	return (
		!isSessionSynchronizing(sessionId) &&
		historyOpenEpoch(sessionId) === opening &&
		sameSource(current, history) &&
		(cursor === undefined || current?.cursor === cursor)
	);
}

/** 旧页只推进同一安装代的历史边界；绝不安装活动态、队列、权限或发送ACK。 */
export function installOlderHistory(
	sessionId: string,
	generation: string,
	cursor: string,
	page: SessionHistoryPage,
	beforePrepend?: () => void,
): boolean {
	if (isSessionSynchronizing(sessionId)) return false;
	let installed = false;
	useTranscriptStore.setState((state) => {
		const current = state.bySession[sessionId],
			history = current?.history;
		if (
			!history ||
			history.generation !== generation ||
			history.cursor !== cursor ||
			page.history.generation !== generation ||
			page.history.sourceVersion !== history.sourceVersion ||
			page.history.hydrationToken !== history.hydrationToken
		)
			return state;
		const ids = new Set(current.messages.map((message) => message.id));
		const older = page.messages.filter((message) => {
			if (ids.has(message.id)) return false;
			ids.add(message.id);
			return true;
		});
		beforePrepend?.();
		installed = true;
		return {
			bySession: {
				...state.bySession,
				[sessionId]: {
					...current,
					messages: [...older, ...current.messages],
					history: page.history,
					historyFetch: undefined,
				},
			},
		};
	});
	return installed;
}

/** 同一页单飞；同SID被replace后可读取新代，旧回应/失败/finally都不能碰新请求。 */
export function loadSessionNavigation(sessionId: string): Promise<SessionNavigation | null> {
	const opening = historyOpenEpoch(sessionId),
		generation = useTranscriptStore.getState().bySession[sessionId]?.history?.generation;
	return Promise.resolve()
		.then(() => getExecutionApi(sessionId).getSessionNavigation({ sessionId }))
		.then((navigation) => {
			const current = useTranscriptStore.getState().bySession[sessionId]?.history;
			if (historyOpenEpoch(sessionId) !== opening || current?.generation !== generation) return null;
			return navigation;
		})
		.catch((error: unknown) => {
			if (import.meta.env.DEV) console.debug("Session navigation unavailable", error);
			return null;
		});
}

export function loadOlderHistory(sessionId: string, beforePrepend?: () => void): Promise<void> {
	if (isSessionSynchronizing(sessionId)) return Promise.resolve();
	const history = useTranscriptStore.getState().bySession[sessionId]?.history,
		cursor = history?.cursor;
	if (!history?.hasOlder || !cursor) return Promise.resolve();
	const opening = historyOpenEpoch(sessionId),
		previous = inFlight.get(sessionId);
	if (
		previous &&
		sameSource(previous.history, history) &&
		previous.cursor === cursor &&
		previous.opening === opening
	)
		return previous.promise as Promise<void>;
	const generation = history.generation;
	useTranscriptStore.setState((state) => {
		const current = state.bySession[sessionId];
		if (current?.history !== history) return state;
		return {
			bySession: {
				...state.bySession,
				[sessionId]: { ...current, historyFetch: { generation, cursor, loading: true } },
			},
		};
	});
	const promise = Promise.resolve()
		.then(() => {
			if (!isCurrent(sessionId, opening, history, cursor)) throw new Error("HISTORY_PAGE_OBSOLETE");
			return getExecutionApi(sessionId).getSessionHistoryPage({ sessionId, cursor });
		})
		.then((page) => {
			if (!isCurrent(sessionId, opening, history, cursor)) return;
			const installed = installOlderHistory(sessionId, generation, cursor, page, beforePrepend);
			const current = useTranscriptStore.getState().bySession[sessionId]?.history;
			if (
				!installed &&
				!isSessionSynchronizing(sessionId) &&
				current?.generation === generation &&
				current.cursor === cursor
			)
				throw new Error("HISTORY_PAGE_STALE: reload the current history baseline");
		})
		.catch((error: unknown) => {
			if (!isCurrent(sessionId, opening, history, cursor)) return;
			useTranscriptStore.setState((state) => {
				const current = state.bySession[sessionId];
				if (current?.history?.generation !== generation || current.history.cursor !== cursor) return state;
				return {
					bySession: {
						...state.bySession,
						[sessionId]: {
							...current,
							historyFetch: {
								generation,
								cursor,
								loading: false,
								error: error instanceof Error ? error.message : String(error),
							},
						},
					},
				};
			});
		})
		.finally(() => {
			if (inFlight.get(sessionId)?.promise === promise) inFlight.delete(sessionId);
		});
	inFlight.set(sessionId, { history, cursor, opening, promise });
	return promise;
}

export async function loadHistoryThrough(
	sessionId: string,
	entryId: string,
	beforePrepend?: () => void,
	intentIsCurrent: () => boolean = () => true,
): Promise<boolean> {
	const history = useTranscriptStore.getState().bySession[sessionId]?.history;
	if (!history || !intentIsCurrent() || isSessionSynchronizing(sessionId)) return false;
	const opening = historyOpenEpoch(sessionId);
	const seen = new Set<string>();
	while (isCurrent(sessionId, opening, history) && intentIsCurrent()) {
		const current = useTranscriptStore.getState().bySession[sessionId];
		if (current?.messages.some((message) => "entryId" in message && message.entryId === entryId)) return true;
		const cursor = current?.history?.cursor;
		if (!current?.history?.hasOlder || !cursor || seen.has(cursor)) return false;
		seen.add(cursor);
		const count = current.messages.length;
		await loadOlderHistory(sessionId, () => {
			if (intentIsCurrent() && isCurrent(sessionId, opening, history)) beforePrepend?.();
		});
		if (!isCurrent(sessionId, opening, history) || !intentIsCurrent()) return false;
		const next = useTranscriptStore.getState().bySession[sessionId];
		if (next?.messages.some((message) => "entryId" in message && message.entryId === entryId)) return true;
		if (next?.historyFetch?.error || next?.history?.cursor === cursor || next?.messages.length === count)
			return false;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		if (!isCurrent(sessionId, opening, history) || !intentIsCurrent()) return false;
	}
	return false;
}
