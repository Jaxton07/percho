import { LAN_CHANNELS } from "@percho/shared";
import type { LanObserverHandle } from "../lan";
import { registerInvokeHandlers } from "./invoke";

/** LAN Observer IPC：仅控制本机服务开关与远程控制开关。 */
export function registerLanIpc(lan: LanObserverHandle): void {
	registerInvokeHandlers(LAN_CHANNELS, {
		lanGetStatus: () => lan.getStatus(),
		lanSetEnabled: ({ enabled }) => {
			if (typeof enabled !== "boolean") throw new Error("lanSetEnabled: enabled must be boolean");
			return lan.setEnabled(enabled);
		},
		lanSetRemoteControl: ({ enabled }) => {
			if (typeof enabled !== "boolean") throw new Error("lanSetRemoteControl: enabled must be boolean");
			return lan.setRemoteControl(enabled);
		},
	});
}
