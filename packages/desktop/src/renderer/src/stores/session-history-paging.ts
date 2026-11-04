import type { SessionHistoryPage, SessionNavigation } from "@percho/shared";
import { getExecutionApi } from "../environment-api";
import { isSessionSynchronizing } from "./session-event-boundary";
import { historyOpenEpoch } from "./session-history";
import { useTranscriptStore } from "./transcript";

const inFlight = new Map<
	string,
	{ generation: string; cursor: string; opening: number; entryId?: string; promise: Promise<unknown> }
>();

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
		previous?.generation === history.generation &&
		previous.cursor === cursor &&
		previous.opening === opening &&
		!previous.entryId
	)
		return previous.promise as Promise<void>;
	if (previous?.opening === opening && previous.entryId)
		return previous.promise.then(() => loadOlderHistory(sessionId, beforePrepend));
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
			if (historyOpenEpoch(sessionId) !== opening) throw new Error("HISTORY_PAGE_OBSOLETE");
			return getExecutionApi(sessionId).getSessionHistoryPage({ sessionId, cursor });
		})
		.then((page) => {
			if (historyOpenEpoch(sessionId) !== opening) return;
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
			if (isSessionSynchronizing(sessionId) || historyOpenEpoch(sessionId) !== opening) return;
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
	inFlight.set(sessionId, { generation, cursor, opening, promise });
	return promise;
}

export function loadHistoryThrough(
	sessionId: string,
	entryId: string,
	beforePrepend?: () => void,
): Promise<boolean> {
	if (isSessionSynchronizing(sessionId)) return Promise.resolve(false);
	const history = useTranscriptStore.getState().bySession[sessionId]?.history,
		cursor = history?.cursor;
	if (!history?.hasOlder || !cursor) return Promise.resolve(false);
	const opening = historyOpenEpoch(sessionId),
		generation = history.generation,
		previous = inFlight.get(sessionId);
	if (
		previous?.entryId === entryId &&
		previous.generation === generation &&
		previous.cursor === cursor &&
		previous.opening === opening
	)
		return previous.promise as Promise<boolean>;
	if (previous?.opening === opening)
		return previous.promise.then(() => {
			const current = useTranscriptStore.getState().bySession[sessionId];
			if (
				historyOpenEpoch(sessionId) !== opening ||
				current?.history?.generation !== generation ||
				isSessionSynchronizing(sessionId)
			)
				return false;
			if (current.messages.some((message) => "entryId" in message && message.entryId === entryId))
				return true;
			if (current.historyFetch?.error && current.history.cursor === cursor) return false;
			return loadHistoryThrough(sessionId, entryId, beforePrepend);
		});
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
			if (historyOpenEpoch(sessionId) !== opening) throw new Error("HISTORY_PAGE_OBSOLETE");
			return getExecutionApi(sessionId).getSessionHistoryThrough({ sessionId, cursor, entryId });
		})
		.then((page) => {
			if (historyOpenEpoch(sessionId) !== opening) return false;
			const installed = installOlderHistory(sessionId, generation, cursor, page, beforePrepend);
			const current = useTranscriptStore.getState().bySession[sessionId]?.history;
			if (
				!installed &&
				!isSessionSynchronizing(sessionId) &&
				current?.generation === generation &&
				current.cursor === cursor
			)
				throw new Error("HISTORY_PAGE_STALE: reload the current history baseline");
			return installed;
		})
		.catch((error: unknown) => {
			if (isSessionSynchronizing(sessionId) || historyOpenEpoch(sessionId) !== opening) return false;
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
			return false;
		})
		.finally(() => {
			if (inFlight.get(sessionId)?.promise === promise) inFlight.delete(sessionId);
		});
	inFlight.set(sessionId, { generation, cursor, opening, entryId, promise });
	return promise;
}
