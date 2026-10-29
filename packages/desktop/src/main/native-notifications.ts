import {
	type NotificationLanguage,
	type NotificationSendResult,
	TASK_NOTIFICATION_COPY,
} from "@percho/shared";
import { app, Notification } from "electron";
import { appIdentity } from "./app-identity";

interface NativeNotice {
	once(event: "show" | "failed" | "close" | "click", listener: () => void): unknown;
	show(): void;
	close(): void;
}

/** Isolated adapter: OS submission is not a receipt that the user saw a notification. */
export class NativeNotifications {
	language: NotificationLanguage = "en";
	enabled = true;
	private notices = new Set<NativeNotice>();
	private generation = 0;
	private preferenceRevision = 0;
	ready: Promise<void> = Promise.resolve();
	constructor(
		private readonly supported: () => boolean,
		private readonly create: (body: string) => NativeNotice,
	) {}
	setLanguage(language: unknown) {
		if (language !== "zh" && language !== "en") throw new Error("Unsupported notification language");
		this.language = language;
	}
	setEnabled(enabled: boolean) {
		this.preferenceRevision += 1;
		this.enabled = enabled;
		if (!enabled) {
			this.generation += 1;
			this.close();
		}
	}
	restoreEnabled(load: () => Promise<boolean>) {
		const revision = this.preferenceRevision;
		this.ready = load()
			.then((enabled) => {
				if (revision === this.preferenceRevision) this.setEnabled(enabled);
			})
			.catch(() => {});
	}
	send(kind: "completed" | "failed" | "test", onClick?: () => void): Promise<NotificationSendResult> {
		if (!this.supported()) return Promise.resolve("unsupported");
		return new Promise((resolve) => {
			const generation = this.generation;
			let notice: NativeNotice | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (result: NotificationSendResult) => {
				clearTimeout(timer);
				resolve(result);
			};
			try {
				notice = this.create(TASK_NOTIFICATION_COPY[this.language][kind]);
				const owned = notice;
				this.notices.add(notice);
				notice.once("show", () => finish("submitted"));
				notice.once("failed", () => {
					this.notices.delete(owned);
					finish("failed");
				});
				notice.once("close", () => this.notices.delete(owned));
				notice.once("click", () => {
					this.notices.delete(owned);
					if (generation === this.generation && (kind === "test" || this.enabled)) onClick?.();
				});
				// Some desktops suppress all callbacks under Do Not Disturb; report submission only.
				timer = setTimeout(() => finish("submitted"), 1500);
				notice.show();
			} catch {
				if (notice) this.notices.delete(notice);
				finish("failed");
			}
		});
	}
	close() {
		for (const notice of this.notices) notice.close();
		this.notices.clear();
	}
}

export const nativeNotifications = new NativeNotifications(
	() => Notification.isSupported(),
	(body) => new Notification({ title: appIdentity.name, body }),
);
export function initializeNativeNotifications() {
	app.once("before-quit", () => nativeNotifications.close());
	nativeNotifications.language = app.getLocale().startsWith("zh") ? "zh" : "en";
}
