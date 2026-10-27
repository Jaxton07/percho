import { type EnvironmentUiState, parseEnvironmentUiState } from "@percho/shared";
import { getPi } from "../api";
import { selectActiveCwd } from "../lib/active-cwd";
import { getDailyDirsCached, rememberDailyDirectory } from "../lib/daily";
import { markMixedWorkspaceState } from "../lib/mixed-workspace-state";
import { useProjectsStore } from "./projects";
import { isWorkspaceRecording, useSessionWorkspaceStore } from "./session-workspace";
import { useSessionsStore } from "./sessions";
import { useUiPreferencesStore } from "./ui-preferences";

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
	const saved = await getPi()
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
				activeFile: null,
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
