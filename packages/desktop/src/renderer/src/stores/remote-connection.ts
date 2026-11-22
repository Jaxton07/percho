import {
	type EnvironmentRef,
	environmentEntityKey,
	environmentKey,
	type RemoteAddCommand,
	type RemoteCatalogSnapshot,
	type RemoteConnectionStatus,
	type RemoteRecordCommand,
	type RemoteRemoveCommand,
	type RemoteSwitchCommand,
	type RemoteTokenCommand,
	type SshPreflight,
} from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { getExecutionApi } from "../environment-api";
import { registerEnvironment } from "../environment-registry";
import { errText } from "../lib/error-text";
import { useInteractionStore } from "./interactions";
import { useProjectsStore } from "./projects";
import { claimActivation, isLatestActivation, noteUserIntent } from "./session-navigation";
import { invalidateEnvironmentSessions, synchronizeEnvironmentSessions, useSessionsStore } from "./sessions";
import { useSettingsStore } from "./settings";
import { pushToast } from "./toasts";

interface RemoteConnectionStore {
	open: boolean;
	status: RemoteConnectionStatus;
	catalog: RemoteCatalogSnapshot;
	lastChecks: Readonly<Record<string, SshPreflight>>;
	getLastCheck: (connectionId: string) => SshPreflight | undefined;
	acceptCatalog: (catalog: RemoteCatalogSnapshot) => void;
	refreshCatalog: () => Promise<void>;
	targetEnvironment: EnvironmentRef | null;
	setOpen: (open: boolean, target?: EnvironmentRef) => void;
	capture: (id?: string) => RemoteRecordCommand;
	add: (alias: string, observation?: Omit<RemoteAddCommand, "alias">) => Promise<string>;
	reconnect: (cmd: RemoteRecordCommand) => Promise<void>;
	switchConnection: (cmd: RemoteSwitchCommand) => Promise<void>;
	confirmTarget: (cmd: RemoteTokenCommand) => Promise<void>;
	resetCatalog: (token: string) => Promise<void>;
	checkOperation: (id: string) => Promise<void>;
	dismissOperation: (id: string) => Promise<void>;
	install: (cmd: RemoteTokenCommand) => Promise<void>;
	prepareInstall: (cmd: RemoteRecordCommand) => Promise<void>;
	connect: (id: string) => Promise<void>;
	preflight: (cmd: RemoteRecordCommand) => Promise<void>;
	forget: (cmd: RemoteRemoveCommand) => Promise<void>;
	disconnect: (cmd: RemoteRecordCommand) => Promise<void>;
	stopService: (cmd: RemoteRecordCommand) => Promise<void>;
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
const EMPTY_CHECKS: Readonly<Record<string, SshPreflight>> = Object.freeze({});

export const useRemoteConnectionStore = create<RemoteConnectionStore>((set, get) => ({
	open: false,
	targetEnvironment: null,
	lastChecks: EMPTY_CHECKS,
	getLastCheck: (id) => get().lastChecks[id],
	status: { revision: -1, state: "disconnected" },
	catalog: { epoch: "", revision: -1, records: [], lastSuccessfulConnectionId: null },
	acceptCatalog: (catalog) => {
		const current = get().catalog;
		if (current.epoch && catalog.epoch !== current.epoch) return;
		if (catalog.revision <= current.revision) return;
		const checks = get().lastChecks;
		const ids = new Set(catalog.records.map((record) => record.connectionId));
		const retained = Object.entries(checks).filter(([id]) => ids.has(id));
		const lastChecks =
			retained.length === Object.keys(checks).length
				? checks
				: retained.length
					? Object.fromEntries(retained)
					: EMPTY_CHECKS;
		set({ catalog, lastChecks });
	},
	refreshCatalog: async () => {
		get().acceptCatalog(await getPi().remoteGetCatalog());
	},
	setOpen: (open, target) => {
		if (!open) projectAttempt++;
		set({ open, targetEnvironment: open ? (target ?? (get().open ? get().targetEnvironment : null)) : null });
	},
	capture: (id) => remoteCommand(get(), id),
	accept: (status) => {
		const previous = get().status;
		if (previous.epoch && status.epoch !== previous.epoch) return;
		if (get().catalog.epoch && status.epoch && status.epoch !== get().catalog.epoch) return;
		if (status.revision <= previous.revision) return;
		const environment = status.environment;
		const changedEnvironment =
			!!previous.environment &&
			(!environment || environmentKey(previous.environment) !== environmentKey(environment));
		const needsSynchronization =
			environment &&
			status.state === "connected" &&
			(previous.state !== "connected" ||
				changedEnvironment ||
				previous.instanceId !== status.instanceId ||
				previous.generation !== status.generation);
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
		const id = status.connectionId;
		const catalog = get().catalog;
		let lastChecks = get().lastChecks;
		if (
			id &&
			status.preflight &&
			(catalog.revision < 0 || catalog.records.some((record) => record.connectionId === id))
		) {
			lastChecks = { ...lastChecks, [id]: status.preflight };
		}
		set({ status, lastChecks });
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
	add: async (alias, observation) => {
		const { catalog, status } = get();
		const epoch = observation?.epoch ?? (status.epoch || catalog.epoch);
		if (
			!epoch ||
			status.generation === undefined ||
			catalog.revision < 0 ||
			(status.epoch && catalog.epoch !== status.epoch)
		)
			throw new Error("Remote connection state is unavailable");
		try {
			const result = await getPi().remoteAdd({
				epoch,
				generation: observation?.generation ?? status.generation,
				catalogRevision: observation?.catalogRevision ?? catalog.revision,
				alias,
			});
			get().acceptCatalog(result.catalog);
			return result.connectionId;
		} catch (error) {
			await get().refreshCatalog();
			throw error;
		}
	},
	resetCatalog: async (token) => {
		const epoch = get().catalog.epoch;
		if (!epoch) throw new Error("Remote connection state is unavailable");
		get().acceptCatalog(await getPi().remoteResetCatalog({ epoch, token }));
	},
	preflight: async (cmd) => {
		try {
			await getPi().remotePreflight(cmd);
		} finally {
			get().accept(await getPi().remoteGetStatus());
		}
	},
	forget: async (cmd) => {
		get().acceptCatalog(await getPi().remoteForget(cmd));
	},
	install: async (cmd) => {
		get().accept(await getPi().remoteInstall(cmd));
	},
	confirmTarget: async (cmd) => {
		get().accept(await getPi().remoteConfirmTarget(cmd));
	},
	prepareInstall: async (cmd) => {
		get().accept(await getPi().remotePrepareInstall(cmd));
	},
	connect: async (id) => {
		get().accept(await getPi().remoteConnect(get().capture(id)));
	},
	reconnect: async (cmd) => {
		get().accept(await getPi().remoteReconnect(cmd));
	},
	switchConnection: async (cmd) => {
		get().accept(await getPi().remoteSwitch(cmd));
	},
	stopService: async (cmd) => {
		get().accept(await getPi().remoteStopService(cmd));
	},
	disconnect: async (cmd) => {
		get().accept(await getPi().remoteDisconnect(cmd));
	},
	openProject: async (path) => {
		const { environment, state, epoch, generation } = get().status;
		if (state !== "connected" || !environment) throw new Error("Connect the remote environment first");
		if (!path.startsWith("/")) throw new Error("Enter an absolute remote project directory");
		noteUserIntent();
		const navigation = claimActivation();
		const attempt = ++projectAttempt;
		const current = () => {
			const status = get().status;
			return (
				attempt === projectAttempt &&
				isLatestActivation(navigation) &&
				status.state === "connected" &&
				status.epoch === epoch &&
				status.generation === generation &&
				!!status.environment &&
				environmentKey(status.environment) === environmentKey(environment)
			);
		};
		const api = getExecutionApi(environment);
		const canonical = await api.validateProjectDirectory({ path });
		if (!current()) return;
		// Trust is the existing target-side decision, routed through the shared dialog bridge.
		set({ open: false });
		const trustCwd = environmentEntityKey(environment, canonical);
		useInteractionStore.getState().setTrustTarget(trustCwd);
		let trusted: boolean;
		try {
			trusted = await api.ensureProjectTrust({ cwd: canonical });
		} finally {
			if (useInteractionStore.getState().foregroundTrustCwd === trustCwd)
				useInteractionStore.getState().setTrustTarget(null);
		}
		if (!trusted) return;
		const cwd = environmentEntityKey(environment, canonical);
		useProjectsStore.getState().addKnownProject(cwd);
		if (!current()) return;
		useSettingsStore.getState().setOpen(false);
		useProjectsStore.getState().select(cwd);
		useSessionsStore.getState().activateNewSessionDraftForCwd(cwd, environment);
	},
}));

function remoteCommand(store: RemoteConnectionStore, id?: string): RemoteRecordCommand {
	const { status, catalog } = store;
	const connectionId = id ?? status.connectionId;
	const epoch = status.epoch || catalog.epoch;
	if (
		!connectionId ||
		!catalog.records.some((record) => record.connectionId === connectionId) ||
		!epoch ||
		status.generation === undefined ||
		(status.epoch && catalog.epoch && status.epoch !== catalog.epoch)
	)
		throw new Error("Remote connection state is unavailable");
	return { epoch, generation: status.generation, connectionId };
}

export function initRemoteConnectionBridge(): () => void {
	const offCatalog = getPi().onRemoteCatalog((catalog) =>
		useRemoteConnectionStore.getState().acceptCatalog(catalog),
	);
	const off = getPi().onRemoteConnectionStatus((status) =>
		useRemoteConnectionStore.getState().accept(status),
	);
	let disposed = false;
	void getPi()
		.remoteGetCatalog()
		.then((catalog) => {
			if (!disposed) useRemoteConnectionStore.getState().acceptCatalog(catalog);
		})
		.catch((error) => {
			if (!disposed && useRemoteConnectionStore.getState().catalog.revision < 0)
				useRemoteConnectionStore.setState((state) => ({
					catalog: { ...state.catalog, error: errText(error) },
				}));
		});
	void getPi()
		.remoteGetStatus()
		.then((status) => {
			if (!disposed) useRemoteConnectionStore.getState().accept(status);
		})
		.catch((error) => {
			if (!disposed && useRemoteConnectionStore.getState().status.revision < 0)
				useRemoteConnectionStore.setState((state) => ({
					status: { ...state.status, state: "error", error: errText(error) },
				}));
		});
	return () => {
		disposed = true;
		cancelSynchronization();
		off();
		offCatalog();
	};
}
