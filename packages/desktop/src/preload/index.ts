import {
	CHANNEL_TABLE,
	type InvokeApi,
	LOCAL_ENVIRONMENT,
	type PiApi,
	SUBSCRIPTION_TABLE,
	type SubscriptionApi,
} from "@percho/shared";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createEnvironmentApi, eventBelongsTo } from "./environment-api";

/** Invoke remains independent: single-object args pass through unchanged. */
const invokeApi = Object.fromEntries(
	Object.entries(CHANNEL_TABLE).map(([key, def]) => [
		key,
		(args: unknown) => ipcRenderer.invoke(def.channel, args),
	]),
) as InvokeApi<typeof CHANNEL_TABLE>;

/** Each subscription owns exactly the listener removed by its returned unsubscribe function. */
const subscriptionApi = Object.fromEntries(
	Object.entries(SUBSCRIPTION_TABLE).map(([key, def]) => [
		key,
		(cb: (...args: unknown[]) => void) => {
			const listener = (_event: unknown, payload: unknown, source?: unknown) => {
				if (def.scope === "environment" && !eventBelongsTo(source, LOCAL_ENVIRONMENT)) return;
				if (def.noPayload) cb();
				else cb(payload);
			};
			ipcRenderer.on(def.channel, listener);
			return () => ipcRenderer.removeListener(def.channel, listener);
		},
	]),
) as unknown as SubscriptionApi<typeof SUBSCRIPTION_TABLE>;

const api: PiApi = {
	forEnvironment: (environment) => createEnvironmentApi(ipcRenderer, environment),
	platform: process.platform,
	getPathForFile: (file) => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
	...invokeApi,
	...subscriptionApi,
};
contextBridge.exposeInMainWorld("pi", api);
