import { networkInterfaces } from "node:os";
import { LanConfigService, LanObserverServer, type PiBackend } from "@percho/backend";
import type { LanStatus } from "@percho/shared";
import * as QRCode from "qrcode";
import observerHtml from "./lan-observer/observer.html?raw";

export interface LanObserverHandle {
	getStatus(): Promise<LanStatus>;
	setEnabled(enabled: boolean): Promise<LanStatus>;
	stop(): Promise<void>;
}

/** Electron 接线：配置落 userData，HTTP server 仍完全位于纯 Node backend。 */
export async function initLanObserver(backend: PiBackend, configPath: string): Promise<LanObserverHandle> {
	const config = new LanConfigService(configPath);
	const server = new LanObserverServer(backend, config, { pageHtml: observerHtml });
	const saved = await config.load();
	if (saved.enabled && saved.token) await server.start();

	return {
		getStatus: async () => statusWithUrls(server, config),
		setEnabled: async (enabled) => {
			if (enabled) {
				await config.save({ enabled: true });
				await config.rotateToken();
				await server.start();
			} else {
				await server.stop();
				await config.save({ enabled: false });
			}
			return statusWithUrls(server, config);
		},
		stop: () => server.stop(),
	};
}

async function statusWithUrls(server: LanObserverServer, config: LanConfigService): Promise<LanStatus> {
	const saved = await config.load();
	const status = server.status();
	if (!status.port || !saved.token) return status;
	const urls = localIpv4Addresses().map((address) => `http://${address}:${status.port}/?t=${saved.token}`);
	return { ...status, urls, qrDataUrl: urls[0] ? await QRCode.toDataURL(urls[0]) : null };
}

/** 物理接口（en、eth、wlan 前缀）优先；跳过 loopback/VPN/bridge，再按接口名和地址稳定排序。 */
function localIpv4Addresses(): string[] {
	const entries = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
		(addresses ?? [])
			.filter(
				(address) =>
					address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254."),
			)
			.map((address) => ({ name, address: address.address })),
	);
	entries.sort(
		(a, b) =>
			interfaceRank(a.name) - interfaceRank(b.name) ||
			a.name.localeCompare(b.name) ||
			a.address.localeCompare(b.address),
	);
	return [...new Set(entries.map((entry) => entry.address))];
}

function interfaceRank(name: string): number {
	if (/^(en|eth|wlan|wl)/i.test(name)) return 0;
	if (/^(utun|bridge|awdl|llw|lo)/i.test(name)) return 2;
	return 1;
}
