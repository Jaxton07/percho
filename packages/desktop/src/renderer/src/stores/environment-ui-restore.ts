import {
	type EnvironmentUiState,
	environmentEntityRef,
	environmentKey,
	LOCAL_ENVIRONMENT,
	parseEnvironmentUiState,
} from "@percho/shared";
import { getPi } from "../api";
import { getExecutionApi } from "../environment-api";
import { selectActiveCwd } from "../lib/active-cwd";
import { getDailyDirsCached, rememberDailyDirectory } from "../lib/daily";
import { markMixedWorkspaceState } from "../lib/mixed-workspace-state";
import { useProjectsStore } from "./projects";
import { useRemoteConnectionStore } from "./remote-connection";
import {
	currentNavigationToken,
	currentUserIntentToken,
	isLatestNavigation,
	isLatestUserIntent,
} from "./session-navigation";
import { isWorkspaceRecording, useSessionWorkspaceStore } from "./session-workspace";
import { useSessionsStore } from "./sessions";
import { useUiPreferencesStore } from "./ui-preferences";

let saved: EnvironmentUiState | null = null;
let initialized = false;
let pending: EnvironmentUiState | null = null;
let flushing = false;
let lastProjection = "";
function persist(): void {
	const projects = useProjectsStore.getState(),
		prefs = useUiPreferencesStore.getState(),
		workspace = useSessionWorkspaceStore.getState();
	const catalog = new Map(projects.allSessions.map((meta) => [meta.sessionId, meta]));
	for (const meta of useSessionsStore.getState().sessions) catalog.set(meta.sessionId, meta);
	const state = parseEnvironmentUiState({
		version: 1,
		projects: projects.addedProjects,
		dailyDirs: getDailyDirsCached(),
		pinnedSessions: prefs.pinnedSessions,
		pinnedProjects: prefs.pinnedProjects,
		expandedGroups: prefs.expandedGroups,
		expandedGroupsTouched: prefs.expandedGroupsTouched,
		lastCwd: selectActiveCwd(useSessionsStore.getState()) ?? prefs.lastCwd,
		workspace: {
			members: workspace.members,
			activeFile: workspace.activeFile,
			recentFile: workspace.recentFile,
		},
		catalog: [...catalog.values()].filter((meta) => !meta.readOnly).slice(0, 10000),
	});
	if (!state) return;
	const projection = JSON.stringify(state);
	if (projection === lastProjection) return;
	lastProjection = projection;
	pending = state;
	if (flushing) return;
	flushing = true;
	void (async () => {
		try {
			while (pending) {
				const next = pending;
				pending = null;
				await getPi().saveEnvironmentUiState({ state: next });
			}
		} catch (error) {
			console.warn("Environment navigation preferences could not be saved", error);
			lastProjection = "";
		} finally {
			flushing = false;
		}
	})();
}
/** Before React mounts: hydrate once, then observe the existing authoritative stores. */
export async function initEnvironmentUiState(): Promise<void> {
	if (initialized) return;
	initialized = true;
	saved = await getPi()
		.loadEnvironmentUiState()
		.catch(() => null);
	if (saved) {
		markMixedWorkspaceState();
		for (const cwd of saved.dailyDirs) rememberDailyDirectory(cwd);
		useProjectsStore.setState({ addedProjects: saved.projects, allSessions: saved.catalog });
		useUiPreferencesStore.setState({
			pinnedSessions: saved.pinnedSessions,
			pinnedProjects: saved.pinnedProjects,
			expandedGroups: saved.expandedGroups,
			expandedGroupsTouched: saved.expandedGroupsTouched,
			lastCwd: saved.lastCwd,
		});
		if (isWorkspaceRecording())
			useSessionWorkspaceStore.setState({
				members: saved.workspace.members,
				activeFile: saved.workspace.activeFile,
				recentFile: saved.workspace.recentFile,
			});
	}
	if (saved) startEnvironmentUiPersistence();
}
let observing = false;
export function startEnvironmentUiPersistence(): void {
	if (observing) return;
	observing = true;
	useProjectsStore.subscribe(persist);
	useUiPreferencesStore.subscribe(persist);
	useSessionWorkspaceStore.subscribe(persist);
	useSessionsStore.subscribe(persist);
	persist();
}
let navigationStarted = false;
/** Background reconciliation never turns an unavailable remote into an empty catalog. */
export function restoreEnvironmentUiNavigation(): void {
	if (!saved || navigationStarted) return;
	navigationStarted = true;
	const snapshot = saved,
		intent = currentUserIntentToken(),
		navigation = currentNavigationToken();
	const activeFile = snapshot.workspace.activeFile;
	const target = activeFile ? environmentEntityRef(activeFile).environment : null;
	const canNavigate = () =>
		isLatestNavigation(navigation) &&
		isLatestUserIntent(intent) &&
		useSessionsStore.getState().activeSessionId === null &&
		isWorkspaceRecording();
	void useProjectsStore
		.getState()
		.load(LOCAL_ENVIRONMENT)
		.then(async () => {
			if (activeFile && target?.kind === "local" && canNavigate())
				await useSessionsStore.getState().openFromHistory(activeFile);
		})
		.catch(() => {});
	if (!activeFile || target?.kind !== "ssh") return;
	let started = false;
	const resume = () => {
		const status = useRemoteConnectionStore.getState().status;
		if (
			started ||
			status.state !== "connected" ||
			!status.environment ||
			environmentKey(status.environment) !== environmentKey(target)
		)
			return;
		started = true;
		void (async () => {
			// Loaded registry includes a still-live zero-message session that has no history file yet.
			const loaded = await getExecutionApi(target).getLoadedSessions();
			if (!canNavigate()) return;
			const member = snapshot.workspace.members.find((item) => item.file === activeFile);
			const meta = loaded.find((item) => item.meta.sessionId === member?.sessionId)?.meta;
			if (meta) {
				useSessionsStore.setState((state) => ({
					sessions: [...state.sessions.filter((item) => item.sessionId !== meta.sessionId), meta],
				}));
				useSessionsStore.getState().switchSession(meta.sessionId);
			} else await useSessionsStore.getState().openFromHistory(activeFile);
		})().catch((error) => console.warn("Saved remote navigation is unavailable", error));
	};
	useRemoteConnectionStore.subscribe(resume);
	resume();
}
