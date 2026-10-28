import { CHANNEL_TABLE, type DesktopApi, type PiApi, SUBSCRIPTION_TABLE } from "@percho/shared";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createEnvironmentApi } from "./environment-api";

/** Invoke remains independent: single-object args pass through unchanged. */
const invokeApi = Object.fromEntries(
	Object.entries(CHANNEL_TABLE)
		.filter(([, def]) => def.scope === "desktop")
		.map(([key, def]) => [key, (args: unknown) => ipcRenderer.invoke(def.channel, args)]),
) as unknown as DesktopApi;

/** Each subscription owns exactly the listener removed by its returned unsubscribe function. */
const subscriptionApi = Object.fromEntries(
	Object.entries(SUBSCRIPTION_TABLE)
		.filter(([, def]) => def.scope === "desktop")
		.map(([key, def]) => [
			key,
			(cb: (...args: unknown[]) => void) => {
				const listener = (_event: unknown, payload: unknown, _source?: unknown) => {
					if (def.noPayload) cb();
					else cb(payload);
				};
				ipcRenderer.on(def.channel, listener);
				return () => ipcRenderer.removeListener(def.channel, listener);
			},
		]),
) as unknown as DesktopApi;

const api: PiApi = {
	forEnvironment: (environment) => createEnvironmentApi(ipcRenderer, environment),
	platform: process.platform,
	getPathForFile: (file) => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
	...invokeApi,
	...subscriptionApi,
};
contextBridge.exposeInMainWorld("pi", api);
