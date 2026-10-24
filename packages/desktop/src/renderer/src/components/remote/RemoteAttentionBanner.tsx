import { environmentEntityRef, sameEnvironment } from "@percho/shared";
import { useState } from "react";
import { createPortal } from "react-dom";
import { getExecutionApi } from "../../environment-api";
import { useT } from "../../i18n";
import { selectActiveCwd } from "../../lib/active-cwd";
import { displayPath } from "../../lib/path-display";
import { useInteractionStore } from "../../stores/interactions";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { useSessionsStore } from "../../stores/sessions";
import { pushToast } from "../../stores/toasts";
import { useTranscriptStore } from "../../stores/transcript";
import { WarningIcon } from "../icons";

/** Passive source notice. It never focuses a control or switches projects on arrival. */
export function RemoteAttentionBanner() {
	const t = useT(),
		active = useSessionsStore((state) => state.activeSessionId),
		cwd = useSessionsStore(selectActiveCwd);
	const environment = useRemoteConnectionStore((state) => state.status.environment);
	const selectedTrust = useInteractionStore((state) => state.selectedTrustId);
	const trust = useInteractionStore((state) =>
		state.trustRequests.find(
			(request) =>
				environment &&
				sameEnvironment(environmentEntityRef(request.id).environment, environment) &&
				request.id !== selectedTrust &&
				request.cwd !== cwd,
		),
	);
	const pending = useTranscriptStore((state) => {
		for (const [id, entry] of Object.entries(state.bySession))
			if (
				id !== active &&
				environment &&
				sameEnvironment(environmentEntityRef(id).environment, environment) &&
				(entry.pendingPermissions.length || entry.pendingDialogs.length)
			)
				return id;
		return null;
	});
	const meta = useSessionsStore((state) => state.sessions.find((session) => session.sessionId === pending));
	const [working, setWorking] = useState(false);
	if (!trust && !pending) return null;
	const source = trust?.cwd ?? meta?.cwd;
	const open = async () => {
		if (trust) {
			useInteractionStore.getState().selectTrust(trust.id);
			return;
		}
		if (!pending) return;
		setWorking(true);
		try {
			if (!meta) {
				const summaries = await getExecutionApi(pending).getLoadedSessions();
				const found = summaries.find((item) => item.meta.sessionId === pending)?.meta;
				if (!found) throw new Error(t("remote.pendingExpired"));
				useSessionsStore.setState((state) => ({
					sessions: [...state.sessions.filter((item) => item.sessionId !== pending), found],
				}));
			}
			useSessionsStore.getState().switchSession(pending);
		} catch (error) {
			pushToast("warning", "remote.syncFailed", error instanceof Error ? error.message : String(error));
		} finally {
			setWorking(false);
		}
	};
	return createPortal(
		<div
			role="status"
			className="fixed bottom-4 right-4 z-30 w-[320px] max-w-[calc(100vw-32px)] rounded-xl bg-surface p-3 shadow-pop"
		>
			<div className="flex items-center gap-2 text-ui-13 text-ink-2">
				<span className="text-warn">
					<WarningIcon />
				</span>
				<span>{t("remote.pendingAttention")}</span>
			</div>
			{source && <p className="mt-1 break-all font-mono text-ui-11 text-ink-faint">{displayPath(source)}</p>}
			<button
				type="button"
				disabled={working}
				className="mt-2 rounded-lg px-2 py-1 text-ui-12 font-medium text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-40"
				onClick={() => void open()}
			>
				{t("remote.review")}
			</button>
		</div>,
		document.body,
	);
}
