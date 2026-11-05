export interface ScrollIntentIdentity {
	sessionId: string | null;
	openEpoch: number;
	historyGeneration: string | number | undefined;
	sequence: number;
}

/** Can also be passed to the history pager to stop requesting subsequent pages. */
export function scrollIntentIsCurrent(
	identity: ScrollIntentIdentity,
	readCurrent: () => ScrollIntentIdentity,
): () => boolean {
	return () => {
		const current = readCurrent();
		return (
			current.sessionId === identity.sessionId &&
			current.openEpoch === identity.openEpoch &&
			current.historyGeneration === identity.historyGeneration &&
			current.sequence === identity.sequence
		);
	};
}
