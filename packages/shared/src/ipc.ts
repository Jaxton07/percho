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

export type DesktopApi = InvokeApi<
	Pick<
		typeof CHANNEL_TABLE,
		{
			[K in keyof typeof CHANNEL_TABLE]: (typeof CHANNEL_TABLE)[K]["scope"] extends "desktop" ? K : never;
		}[keyof typeof CHANNEL_TABLE]
	>
> &
	SubscriptionApi<
		Pick<
			typeof SUBSCRIPTION_TABLE,
			{
				[K in keyof typeof SUBSCRIPTION_TABLE]: (typeof SUBSCRIPTION_TABLE)[K]["scope"] extends "desktop"
					? K
					: never;
			}[keyof typeof SUBSCRIPTION_TABLE]
		>
	>;

/** Environment operations are accessible only through an explicitly bound API. */
export interface PiApi extends DesktopApi {
	forEnvironment(environment: EnvironmentRef): EnvironmentApi;
	readonly platform: "darwin" | "win32" | "linux" | (string & {});
	getPathForFile(file: unknown): string;
}
