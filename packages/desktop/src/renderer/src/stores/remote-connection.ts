import { environmentEntityKey, environmentKey, type RemoteConnectionStatus } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { getExecutionApi } from "../environment-api";
import { registerEnvironment } from "../environment-registry";
import { errText } from "../lib/error-text";
import { useInteractionStore } from "./interactions";
import { useProjectsStore } from "./projects";
import { claimActivation, isLatestActivation, noteUserIntent } from "./session-navigation";
import { invalidateEnvironmentSessions, synchronizeEnvironmentSessions, useSessionsStore } from "./sessions";
import { pushToast } from "./toasts";

interface RemoteConnectionStore {
	open: boolean;
	status: RemoteConnectionStatus;
	setOpen: (open: boolean) => void;
	checkOperation: (id: string) => Promise<void>;
	dismissOperation: (id: string) => Promise<void>;
	install: (token: string) => Promise<void>;
	prepareInstall: (alias: string) => Promise<void>;
	connect: (alias: string) => Promise<void>;
	preflight: (alias: string) => Promise<void>;
	forget: () => Promise<void>;
	disconnect: () => Promise<void>;
	stopService: () => Promise<void>;
	openProject: (path: string) => Promise<void>;
	accept: (status: RemoteConnectionStatus) => void;
}
let projectAttempt = 0;
let registered: string | undefined;
let unregister: (() => void) | undefined;
let synchronizationEpoch = 0;
let synchronizationRetry: ReturnType<typeof setTimeout> | undefined;
function cancelSynchronization(): void {
	synchronizationEpoch++;
	clearTimeout(synchronizationRetry);
	synchronizationRetry = undefined;
}
function startSynchronization(
	environment: NonNullable<RemoteConnectionStatus["environment"]>,
	generation: number,
): void {
	const epoch = synchronizationEpoch;
	const current = () => {
		const status = useRemoteConnectionStore.getState().status;
		return (
			epoch === synchronizationEpoch &&
			status.state === "connected" &&
			status.environment &&
			environmentKey(status.environment) === environmentKey(environment)
		);
	};
	const attempt = async (token: number, retry: number): Promise<void> => {
		try {
			await synchronizeEnvironmentSessions(environment, token);
		} catch (error) {
			if (!current()) return;
			console.warn("Remote session synchronization failed", error);
			if (retry === 0) pushToast("warning", "remote.syncFailed", errText(error));
			// Keep mutations paused until a fresh summary succeeds. Disconnect cancels the retry.
			synchronizationRetry = setTimeout(
				() => {
					synchronizationRetry = undefined;
					if (current()) void attempt(invalidateEnvironmentSessions(environment), retry + 1);
				},
				Math.min(1000 * 2 ** Math.min(retry, 4), 10_000),
			);
		}
	};
	void attempt(generation, 0);
}
export const useRemoteConnectionStore = create<RemoteConnectionStore>((set, get) => ({
	open: false,
	status: { revision: -1, state: "disconnected" },
	setOpen: (open) => {
		if (!open) projectAttempt++;
		set({ open });
	},
	accept: (status) => {
		if (status.revision <= get().status.revision) return;
		const previous = get().status;
		const environment = status.environment;
		const changedEnvironment =
			!!previous.environment &&
			(!environment || environmentKey(previous.environment) !== environmentKey(environment));
		const needsSynchronization =
			environment &&
			status.state === "connected" &&
			(previous.state !== "connected" || changedEnvironment || previous.instanceId !== status.instanceId);
		if (status.state !== "connected" || needsSynchronization) cancelSynchronization();
		if (!environment && registered) {
			unregister?.();
			unregister = undefined;
			registered = undefined;
		}
		if (environment && environmentKey(environment) !== registered) {
			unregister?.();
			unregister = registerEnvironment(environment);
			registered = environmentKey(environment);
		}
		if (
			previous.environment &&
			previous.state === "connected" &&
			(status.state !== "connected" || changedEnvironment)
		)
			invalidateEnvironmentSessions(previous.environment);
		set({ status });
		if (environment && status.state === "connected") {
			if (needsSynchronization) {
				if (previous.instanceId && status.instanceId && previous.instanceId !== status.instanceId)
					pushToast("warning", "remote.restarted");
				const generation = invalidateEnvironmentSessions(environment);
				startSynchronization(environment, generation);
				void useProjectsStore.getState().load(environment);
				void useSessionsStore.getState().loadModels(environment);
			}
		}
	},
	checkOperation: async (id) => {
		await getPi().remoteCheckOperation({ operationId: id });
	},
	dismissOperation: async (id) => {
		await getPi().remoteDismissOperation({ operationId: id });
	},
	preflight: async (alias) => {
		await getPi().remotePreflight({ alias });
	},
	forget: async () => {
		get().accept(await getPi().remoteForget());
	},
	install: async (token) => {
		get().accept(await getPi().remoteInstall({ token }));
	},
	prepareInstall: async (alias) => {
		get().accept(await getPi().remotePrepareInstall({ alias }));
	},
	connect: async (alias) => {
		get().accept(await getPi().remoteConnect({ alias }));
	},
	stopService: async () => {
		get().accept(await getPi().remoteStopService());
	},
	disconnect: async () => {
		get().accept(await getPi().remoteDisconnect());
	},
	openProject: async (path) => {
		const { environment, state } = get().status;
		if (state !== "connected" || !environment) throw new Error("Connect the remote environment first");
		if (!path.startsWith("/")) throw new Error("Enter an absolute remote project directory");
		noteUserIntent();
		const navigation = claimActivation();
		const attempt = ++projectAttempt;
		const current = () => attempt === projectAttempt && isLatestActivation(navigation);
		const api = getExecutionApi(environment);
		const canonical = await api.validateProjectDirectory({ path });
		if (!current()) return;
		// Trust is the existing target-side decision, routed through the shared dialog bridge.
		set({ open: false });
		const trustCwd = environmentEntityKey(environment, canonical);
		useInteractionStore.getState().setTrustTarget(trustCwd);
		try {
			await api.ensureProjectTrust({ cwd: canonical });
		} finally {
			if (useInteractionStore.getState().foregroundTrustCwd === trustCwd)
				useInteractionStore.getState().setTrustTarget(null);
		}
		const cwd = environmentEntityKey(environment, canonical);
		useProjectsStore.getState().addKnownProject(cwd);
		if (!current()) return;
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
		cancelSynchronization();
		off();
	};
}
