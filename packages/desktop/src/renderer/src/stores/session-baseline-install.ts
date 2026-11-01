import type { SessionBaseline } from "@percho/shared";
import { measureRendererSwitch } from "../lib/session-switch-probe";
import { finishSessionBaseline } from "./session-event-boundary";
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
		useTranscriptStore.setState((state) => ({
			bySession: {
				...state.bySession,
				[sessionId]: {
					...baseline.transcript,
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
