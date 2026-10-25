import {
	type EnvironmentRef,
	environmentRef,
	SUBSCRIPTION_TABLE,
	type SubscriptionChannel,
	type SubscriptionPayload,
} from "@percho/shared";
import { BrowserWindow } from "electron";

/** 向 renderer 推事件（backend 事件转发 + 更新状态共用） */
export function sendToRenderer<C extends SubscriptionChannel>(
	channel: C,
	payload: NoInfer<SubscriptionPayload<C>>,
	environment?: EnvironmentRef,
): void {
	if (environment) {
		const def = Object.values(SUBSCRIPTION_TABLE).find((entry) => entry.channel === channel);
		if (def?.scope !== "environment") throw new Error("Desktop events cannot originate remotely");
		environment = environmentRef(environment);
	}
	const window = BrowserWindow.getAllWindows()[0];
	if (window && !window.isDestroyed()) {
		if (environment) window.webContents.send(channel, payload, environment);
		else window.webContents.send(channel, payload);
	}
}

/** Explicit source binding; infer the payload from the channel, never from a mismatched source. */
export function forward<C extends SubscriptionChannel>(
	subscribe: (handler: (payload: NoInfer<SubscriptionPayload<C>>) => void) => void,
	channel: C,
): void {
	subscribe((payload) => sendToRenderer(channel, payload));
}
