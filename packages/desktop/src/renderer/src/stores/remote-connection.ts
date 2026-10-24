import { environmentEntityKey, environmentKey, type RemoteConnectionStatus } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { getExecutionApi } from "../environment-api";
import { registerEnvironment } from "../environment-registry";
import { useProjectsStore } from "./projects";
import { useSessionsStore } from "./sessions";

interface RemoteConnectionStore {
	open: boolean;
	status: RemoteConnectionStatus;
	setOpen: (open: boolean) => void;
	connect: (alias: string) => Promise<void>;
	disconnect: () => Promise<void>;
	openProject: (path: string) => Promise<void>;
	accept: (status: RemoteConnectionStatus) => void;
}
let registered: string | undefined;
let unregister: (() => void) | undefined;
export const useRemoteConnectionStore = create<RemoteConnectionStore>((set, get) => ({
	open: false,
	status: { revision: -1, state: "disconnected" },
	setOpen: (open) => set({ open }),
	accept: (status) => {
		if (status.revision <= get().status.revision) return;
		const environment = status.environment;
		if (environment && environmentKey(environment) !== registered) {
			unregister?.();
			unregister = registerEnvironment(environment);
			registered = environmentKey(environment);
		}
		set({ status });
		if (environment && status.state === "connected") {
			void useProjectsStore.getState().load(environment);
			void useSessionsStore.getState().loadModels(environment);
		}
	},
	connect: async (alias) => {
		get().accept(await getPi().remoteConnect({ alias }));
	},
	disconnect: async () => {
		get().accept(await getPi().remoteDisconnect());
	},
	openProject: async (path) => {
		const { environment, state } = get().status;
		if (state !== "connected" || !environment) throw new Error("Connect the remote environment first");
		if (!path.startsWith("/")) throw new Error("Enter an absolute remote project directory");
		const api = getExecutionApi(environment);
		const canonical = await api.resolvePath({ target: path, cwd: null });
		// Trust is the existing target-side decision, routed through the shared dialog bridge.
		set({ open: false });
		await api.ensureProjectTrust({ cwd: canonical });
		const cwd = environmentEntityKey(environment, canonical);
		useProjectsStore.getState().addKnownProject(cwd);
		useProjectsStore.getState().select(cwd);
		useSessionsStore.getState().activateNewSessionDraftForCwd(cwd, environment);
	},
}));

export function initRemoteConnectionBridge(): () => void {
	const off = getPi().onRemoteConnectionStatus((status) =>
		useRemoteConnectionStore.getState().accept(status),
	);
	let disposed = false;
	void getPi()
		.remoteGetStatus()
		.then((status) => {
			if (!disposed) useRemoteConnectionStore.getState().accept(status);
		})
		.catch(() => {});
	return () => {
		disposed = true;
		off();
	};
}
