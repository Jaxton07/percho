import {
	buildChatRows,
	deriveTurnChanges,
	type SessionTranscriptState,
	type TurnChanges,
	type TurnFileChange,
} from "@percho/shared";

export function thinkingViewKey(
	sourceId: string | undefined,
	group: string | undefined,
	index: number,
): string {
	return `thinking:${sourceId ?? `${group}:${index}`}`;
}

export function diffFileViewKey(
	turn: Pick<TurnChanges, "turnId" | "turnIndex">,
	file: Pick<TurnFileChange, "path">,
): string {
	return `file:${turn.turnId ?? `legacy:${turn.turnIndex}`}:${file.path}`;
}

/** Only retained source identities survive a baseline replacement; never position-only keys. */
export function sessionDetailKeys(state: SessionTranscriptState, sessionId: string): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const row of buildChatRows(state, sessionId)) {
		if (row.kind !== "metaGroup") continue;
		keys.add(`meta:${row.key}`);
		row.items.forEach((item, index) => {
			keys.add(thinkingViewKey(item.sourceId, row.key, index));
			for (const tool of item.tools) {
				keys.add(`tool:${tool.key}`);
			}
		});
	}
	for (const turn of deriveTurnChanges(state.messages))
		for (const file of turn.files) {
			keys.add(diffFileViewKey(turn, file));
			for (const section of file.sections) keys.add(`full:${section.toolCallKey}`);
		}
	return keys;
}
