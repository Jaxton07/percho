import { parentPort, workerData } from "node:worker_threads";
// @ts-expect-error Node source workers require the extension.
import { ChannelStore } from "./store.ts";

const port = parentPort;
if (!port) throw new Error("Channel worker requires a parent port");
const store = new ChannelStore(workerData as { projectRoot: string; agentDir: string });
const methods = new Set([
	"manage",
	"snapshot",
	"post",
	"read",
	"prepareMaintenance",
	"completeMaintenance",
	"pendingMaintenance",
]);
port.on("message", ({ id, method, args }: { id: number; method: string; args: unknown[] }) => {
	try {
		if (method === "close") {
			store.close();
			port.postMessage({ id });
			return;
		}
		if (!methods.has(method)) throw new Error("Unknown channel method");
		const fn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
		if (typeof fn !== "function") throw new Error(`Channel method unavailable: ${method}`);
		port.postMessage({ id, result: fn.apply(store, args) });
	} catch (error) {
		port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
