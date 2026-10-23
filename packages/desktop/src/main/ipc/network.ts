import { NETWORK_CHANNELS } from "@percho/shared";
import type { NetworkSettingsService } from "../network-settings";
import { testNetworkConnection } from "../network-test";
import { registerInvokeHandlers } from "./invoke";

export function registerNetworkIpc(network: NetworkSettingsService): void {
	registerInvokeHandlers(NETWORK_CHANNELS, {
		loadNetworkSettings: () => network.load(),
		saveNetworkSettings: ({ settings }) => network.save(settings),
		testNetworkConnection: ({ settings }) => testNetworkConnection(settings),
	});
}
