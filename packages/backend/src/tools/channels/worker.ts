import { parentPort, workerData } from "node:worker_threads";
// @ts-expect-error Node source workers require the extension.
import { ChannelDatabase } from "./database.ts";
// @ts-expect-error Node source workers require the extension.
import { ChannelStore } from "./store.ts";

const port = parentPort;
if (!port) throw new Error("Channel worker requires a parent port");
const options = workerData as { agentDir: string };
const database = new ChannelDatabase(options);
const projects = new Map<string, ChannelStore>();
const projectMethods = new Set([
	"manage",
	"snapshot",
	"post",
	"read",
	"prepareMaintenance",
	"completeMaintenance",
	"pendingMaintenance",
]);
const databaseMethods = new Set([
	"register",
	"bind",
	"binding",
	"deleteFingerprint",
	"recordDeleteFingerprint",
	"fences",
	"find",
]);
port.on(
	"message",
	({
		id,
		method,
		args,
		projectRoot,
	}: {
		id: number;
		method: string;
		args: unknown[];
		projectRoot?: string;
	}) => {
		try {
			if (method === "close") {
				database.close();
				projects.clear();
				port.postMessage({ id });
				return;
			}
			let target: ChannelStore | ChannelDatabase;
			if (projectMethods.has(method) && typeof projectRoot === "string") {
				let project = projects.get(projectRoot);
				if (!project) {
					project = new ChannelStore({ ...options, projectRoot, database });
					projects.set(projectRoot, project);
				}
				target = project;
			} else if (databaseMethods.has(method) && projectRoot === undefined) {
				target = database;
			} else {
				throw new Error("Unknown channel method or missing project scope");
			}
			const fn = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
			if (!fn) throw new Error(`Channel method unavailable: ${method}`);
			port.postMessage({ id, result: fn.apply(target, args) });
		} catch (error) {
			port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
		}
	},
);
