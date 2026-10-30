import { existsSync } from "node:fs";
import {
	type EnvironmentRef,
	IpcChannels,
	type SessionEventEnvelope,
	type SessionMeta,
	type TaskNotificationClick,
	type TaskNotificationTarget,
} from "@percho/shared";
import { app, BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { nativeNotifications } from "./native-notifications";
import { TaskNotificationObserver } from "./task-notification-observer";

const getWindow = () => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());

/** Queues only a user click awaiting renderer navigation readiness, never task results. */
export class TaskNotificationNavigation {
	private ready = false;
	private pending?: { target: TaskNotificationTarget; valid: () => boolean };
	constructor(
		private readonly restore: () => void,
		private readonly deliver: (click: TaskNotificationClick) => void,
	) {}
	click(target: TaskNotificationTarget, valid: () => boolean) {
		this.restore();
		if (!this.ready) {
			this.pending = { target, valid };
			return;
		}
		this.deliver({ target: valid() ? target : null, queued: false });
	}
	setReady(ready: boolean) {
		this.ready = ready;
		if (!ready || !this.pending) return;
		const pending = this.pending;
		this.pending = undefined;
		this.deliver({ target: pending.valid() ? pending.target : null, queued: true });
	}
	clear() {
		this.pending = undefined;
		this.ready = false;
	}
}
export const taskNotificationNavigation = new TaskNotificationNavigation(
	() => {
		const window = getWindow();
		if (!window) return;
		if (window.isMinimized()) window.restore();
		window.show();
		window.focus();
	},
	(click) => getWindow()?.webContents.send(IpcChannels.TaskNotificationClick, click),
);
export const taskNotificationObserver = new TaskNotificationObserver({
	enabled: () => nativeNotifications.enabled,
	background: () => {
		const window = getWindow();
		return !!window && (!window.isFocused() || !window.isVisible() || window.isMinimized());
	},
	ready: () => nativeNotifications.ready,
	send: (kind, target, valid) =>
		nativeNotifications.send(kind, () =>
			taskNotificationNavigation.click(
				target,
				() =>
					valid() &&
					(target.environment.kind !== "local" || !target.sessionFile || existsSync(target.sessionFile)),
			),
		),
});
/** Notification bugs cannot interrupt SDK event delivery or turn a successful task into an error. */
export function observeTaskNotification(
	environment: EnvironmentRef,
	payload: SessionEventEnvelope,
	getMeta: () => SessionMeta | undefined | Promise<SessionMeta | undefined>,
) {
	try {
		taskNotificationObserver.observe(environment, payload, getMeta);
	} catch {
		console.warn("Task notification observation unavailable");
	}
}
export function setTaskNotificationNavigationReady(
	{ ready }: { ready: boolean },
	event?: IpcMainInvokeEvent,
) {
	const window = getWindow();
	if (
		!window ||
		!event ||
		event.sender !== window.webContents ||
		event.senderFrame !== event.sender.mainFrame ||
		typeof ready !== "boolean"
	)
		throw new Error("Invalid notification navigation source");
	taskNotificationNavigation.setReady(ready);
}
export function initializeTaskNotifications() {
	app.once("before-quit", () => {
		taskNotificationObserver.stop();
		taskNotificationNavigation.clear();
	});
}
