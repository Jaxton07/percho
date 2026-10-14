/** Structural input keeps the current-directory rule independent of stores and React. */
export interface ActiveCwdState {
	activeSessionId: string | null;
	sessions: readonly { sessionId: string; cwd: string }[];
	newSessionDraft: { cwd: string | null } | null;
	cwd: string | null;
}

export function selectActiveCwd(state: ActiveCwdState): string | null {
	if (state.activeSessionId === null) return state.newSessionDraft?.cwd ?? null;
	return state.sessions.find((session) => session.sessionId === state.activeSessionId)?.cwd ?? state.cwd;
}
