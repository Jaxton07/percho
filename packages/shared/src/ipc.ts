import type { EnvironmentRef } from "./environment";
import type { CHANNEL_TABLE, InvokeApi, SUBSCRIPTION_TABLE, SubscriptionApi } from "./ipc-channels";

export {
	type AnyChannelDef,
	APP_CHANNELS,
	CHANNEL_TABLE,
	type ChannelCtor,
	type ChannelDef,
	type ChannelScope,
	ch,
	EXTENSION_DIALOG_CHANNELS,
	type InvokeApi,
	type InvokeHandlers,
	IpcChannels,
	LAN_CHANNELS,
	PACKAGES_CHANNELS,
	SESSION_CHANNELS,
	SETTINGS_CHANNELS,
	SUBSCRIPTION_TABLE,
	type SubscriptionApi,
	type SubscriptionChannel,
	type SubscriptionPayload,
	UI_PLUGINS_CHANNELS,
} from "./ipc-channels";

type EnvironmentInvokeTable = Pick<
	typeof CHANNEL_TABLE,
	{
		[K in keyof typeof CHANNEL_TABLE]: (typeof CHANNEL_TABLE)[K]["scope"] extends "environment" ? K : never;
	}[keyof typeof CHANNEL_TABLE]
>;
type EnvironmentSubscriptionTable = Pick<
	typeof SUBSCRIPTION_TABLE,
	{
		[K in keyof typeof SUBSCRIPTION_TABLE]: (typeof SUBSCRIPTION_TABLE)[K]["scope"] extends "environment"
			? K
			: never;
	}[keyof typeof SUBSCRIPTION_TABLE]
>;

export type EnvironmentMethod = keyof EnvironmentInvokeTable;
export type EnvironmentApi = InvokeApi<EnvironmentInvokeTable> &
	SubscriptionApi<EnvironmentSubscriptionTable>;

/** Invoke and subscription members come from their own tables; native synchronous fields stay explicit. */
export interface PiApi extends InvokeApi<typeof CHANNEL_TABLE>, SubscriptionApi<typeof SUBSCRIPTION_TABLE> {
	/** Bind once; this object cannot change its target when the selected project changes. */
	forEnvironment(environment: EnvironmentRef): EnvironmentApi;
	/** 运行平台（preload 同步注入，供 renderer 按平台分流 UI） */
	readonly platform: "darwin" | "win32" | "linux" | (string & {});
	/** Electron 沙箱渲染器中的 File 不再带 path；由 preload 同步解析拖入文件路径。 */
	getPathForFile(file: unknown): string;
}
