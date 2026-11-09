import { environmentEntityRef, environmentKey, type SessionMeta } from "@percho/shared";
import { getExecutionApi } from "../environment-api";
import { errText } from "../lib/error-text";
import { useChannelSubscriptionsStore } from "./channel-subscriptions";
import { useLocalSessionsStore } from "./local-sessions";
import { useProjectsStore } from "./projects";
import { useRemoteConnectionStore } from "./remote-connection";
import { useSessionCatalogStore } from "./session-catalog";
import {
	currentNavigationToken,
	currentUserIntentToken,
	isLatestNavigation,
	isLatestUserIntent,
} from "./session-navigation";
import { useSessionWorkspaceStore } from "./session-workspace";
import { useSessionsStore } from "./sessions";
import { pushToast } from "./toasts";
import { useTranscriptStore } from "./transcript";
import { useUiPreferencesStore } from "./ui-preferences";

export function archiveDisabledReason(meta: SessionMeta): "history" | "busy" | "offline" | undefined {
	const entry = useTranscriptStore.getState().bySession[meta.sessionId];
	const hasHistory =
		meta.messageCount > 0 ||
		entry?.messages?.some(
			(message) => message.kind === "assistant" || (message.kind === "user" && !message.pending),
		);
	if (!meta.sessionFile || !hasHistory) return "history";
	const environment = environmentEntityRef(meta.sessionId).environment;
	if (environment.kind === "ssh") {
		const status = useRemoteConnectionStore.getState().status;
		if (
			status.state !== "connected" ||
			!status.environment ||
			environmentKey(status.environment) !== environmentKey(environment)
		)
			return "offline";
	}
	if (
		entry &&
		(entry.phase !== "idle" ||
			entry.streaming ||
			entry.followUpQueue.length ||
			entry.pendingPermissions.length ||
			entry.pendingDialogs.length)
	)
		return "busy";
	return undefined;
}

export function archiveHasSubscriptions(sessionId: string): boolean {
	return (useChannelSubscriptionsStore.getState().bySession[sessionId]?.topics.length ?? 0) > 0;
}

export async function archiveSession(meta: SessionMeta): Promise<void> {
	if (archiveDisabledReason(meta) || !meta.sessionFile) return;
	const environment = environmentEntityRef(meta.sessionId).environment;
	const active = useSessionsStore.getState().activeSessionId;
	const navigation = currentNavigationToken();
	const intent = currentUserIntentToken();
	try {
		const result = await getExecutionApi(environment).archiveSession({
			sessionId: meta.sessionId,
			sessionFile: meta.sessionFile,
			expectedRevision: meta.archiveRevision ?? 0,
		});
		if (!result.archived) throw new Error("Archive was not completed");
		const navigate =
			active === meta.sessionId &&
			useSessionsStore.getState().activeSessionId === meta.sessionId &&
			isLatestNavigation(navigation) &&
			isLatestUserIntent(intent);
		useSessionsStore.getState().forgetArchivedSession(meta.sessionId, navigate);
		useLocalSessionsStore.getState().forget(meta.sessionId);
		useUiPreferencesStore.getState().unpin(meta.sessionId);
		useSessionWorkspaceStore.getState().removeMember(meta.sessionId);
		useProjectsStore.setState((state) => ({
			allSessions: state.allSessions.filter((s) => s.sessionId !== meta.sessionId),
		}));
		const key = environmentKey(environment);
		useSessionCatalogStore.setState((state) => {
			const catalog = state.byEnvironment[key];
			if (!catalog) return state;
			const pages = Object.fromEntries(
				Object.entries(catalog.pages).map(([pageKey, page]) => [
					pageKey,
					page.query.archived
						? page
						: { ...page, sessions: page.sessions.filter((s) => s.sessionId !== meta.sessionId) },
				]),
			);
			return { byEnvironment: { ...state.byEnvironment, [key]: { ...catalog, pages } } };
		});
		useSessionCatalogStore.getState().invalidate(environment);
		pushToast(
			result.cleanupPending ? "warning" : "info",
			result.cleanupPending ? "sessionArchive.cleanupPending" : "sessionArchive.success",
		);
	} catch (error) {
		pushToast("error", "sessionArchive.failed", errText(error));
	}
}
