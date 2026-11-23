import type { SessionBaseline } from "@percho/shared";
import { measureRendererSwitch } from "../lib/session-switch-probe";
import { sessionDetailKeys } from "../lib/session-view-keys";
import { finishSessionBaseline } from "./session-event-boundary";
import { useSessionViewStore } from "./session-view";
import { useTranscriptStore } from "./transcript";

/** 历史和进行中轮次一同替换，之后按sequence重放读取期间的增量。 */
export function installSessionBaseline(
	sessionId: string,
	token: number,
	baseline: SessionBaseline,
	land?: () => void,
): boolean {
	return finishSessionBaseline(sessionId, token, baseline.sequence, () => {
		const end = measureRendererSwitch("historyInstall");
		const previous = useTranscriptStore.getState().bySession[sessionId];
		useSessionViewStore.getState().ensure(sessionId);
		useSessionViewStore.getState().prune(sessionId, sessionDetailKeys(baseline.transcript, sessionId));
		useTranscriptStore.setState((state) => ({
			bySession: {
				...state.bySession,
				[sessionId]: {
					...baseline.transcript,
					// A snapshot start belongs to the server clock, not a live start observed here.
					streaming: baseline.transcript.streaming
						? {
								...baseline.transcript.streaming,
								tools: baseline.transcript.streaming.tools.map((tool) => ({ ...tool, startedAt: undefined })),
							}
						: null,
					baselineRevision: (previous?.baselineRevision ?? 0) + 1,
					phase: previous?.pendingPermissions.length ? "awaiting_permission" : baseline.transcript.phase,
					pendingPermissions: previous?.pendingPermissions ?? [],
					pendingDialogs: previous?.pendingDialogs ?? [],
				},
			},
		}));
		land?.();
		end();
	});
}
