import { environmentEntityKey, sameEnvironment, type TaskNotificationClick } from "@percho/shared";
import { getPi } from "../api";
import { useRemoteConnectionStore } from "./remote-connection";
import { currentUserIntentToken } from "./session-navigation";
import { useSessionsStore } from "./sessions";
import { pushToast } from "./toasts";

/** Installed after workbench bootstrap, never gated by a particular session's history ACK. */
export function initTaskNotificationNavigation() {
	const intentAtReady = currentUserIntentToken();
	let disposed = false;
	let attempt = 0;
	const open = async ({ target, queued }: TaskNotificationClick) => {
		const ownAttempt = ++attempt;
		const intent = currentUserIntentToken();
		if (queued && currentUserIntentToken() !== intentAtReady) return;
		if (!target) {
			pushToast("warning", "notifications.targetUnavailable");
			return;
		}
		const id = environmentEntityKey(target.environment, target.sessionId);
		let remoteRevision: number | undefined;
		if (target.environment.kind === "ssh") {
			const status = await getPi().remoteGetStatus();
			if (disposed || attempt !== ownAttempt) return;
			if (
				status.state !== "connected" ||
				!status.environment ||
				!sameEnvironment(status.environment, target.environment)
			) {
				pushToast("warning", "notifications.targetUnavailable");
				return;
			}
			useRemoteConnectionStore.getState().accept(status);
			remoteRevision = status.revision;
		}
		let started = false;
		const current = () =>
			!disposed &&
			ownAttempt === attempt &&
			(started || intent === currentUserIntentToken()) &&
			(remoteRevision === undefined ||
				useRemoteConnectionStore.getState().status.revision === remoteRevision);
		if (!current()) return;
		if (useSessionsStore.getState().sessions.some((meta) => meta.sessionId === id)) {
			useSessionsStore.getState().switchSession(id);
			return;
		}
		if (!target.sessionFile) {
			pushToast("warning", "notifications.targetUnavailable");
			return;
		}
		started = true;
		const result = await useSessionsStore
			.getState()
			.openFromHistory(
				environmentEntityKey(target.environment, target.sessionFile),
				(meta) => current() && meta.sessionId === id,
			);
		if (result.ok && result.meta.sessionId !== id && current())
			pushToast("warning", "notifications.targetUnavailable");
	};
	const unsubscribe = getPi().onTaskNotificationClick((click) => {
		void open(click).catch(() => {
			if (!disposed) pushToast("warning", "notifications.targetUnavailable");
		});
	});
	void getPi()
		.setTaskNotificationNavigationReady({ ready: true })
		.catch(() => {});
	return () => {
		disposed = true;
		attempt++;
		unsubscribe();
		void getPi()
			.setTaskNotificationNavigationReady({ ready: false })
			.catch(() => {});
	};
}
