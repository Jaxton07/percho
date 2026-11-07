import {
	type EnvironmentUiState,
	environmentEntityRef,
	environmentKey,
	parseEnvironmentUiState,
	type SessionCatalogReference,
} from "@percho/shared";
import { getPi } from "../api";
import { getExecutionApi } from "../environment-api";
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
	const epoch = useSessionWorkspaceStore.getState().epoch;
	const saved = await getPi()
		.loadEnvironmentUiState()
		.catch(() => null);
	if (saved) {
		markMixedWorkspaceState();
		for (const cwd of saved.dailyDirs) rememberDailyDirectory(cwd);
		useProjectsStore.setState((state) => ({
			addedProjects: saved.projects,
			allSessions: [
				...new Map([...saved.catalog, ...state.allSessions].map((meta) => [meta.sessionId, meta])).values(),
			],
		}));
		useUiPreferencesStore.setState({
			pinnedSessions: saved.pinnedSessions,
			pinnedProjects: saved.pinnedProjects,
			expandedGroups: saved.expandedGroups,
			expandedGroupsTouched: saved.expandedGroupsTouched,
			lastCwd: saved.lastCwd,
		});
		if (isWorkspaceRecording() && useSessionWorkspaceStore.getState().epoch === epoch) {
			const current = useSessionWorkspaceStore.getState();
			const members = [
				...saved.workspace.members.filter(
					(member) =>
						!current.members.some((item) => item.file === member.file || item.sessionId === member.sessionId),
				),
				...current.members,
			];
			useSessionWorkspaceStore.setState({
				members,
				activeFile: current.activeFile,
				recentFile: current.recentFile ?? saved.workspace.recentFile,
			});
		}
	}
	if (saved) {
		startEnvironmentUiPersistence();
		if (useSessionWorkspaceStore.getState().epoch === epoch) void verifyMixedWorkspace(saved);
	}
}
async function verifyMixedWorkspace(saved: EnvironmentUiState): Promise<void> {
	const epoch = useSessionWorkspaceStore.getState().epoch;
	let pinnedAtStart = useUiPreferencesStore.getState().pinnedSessions;
	const groups = new Map<
		string,
		{
			environment: ReturnType<typeof environmentEntityRef>["environment"];
			references: SessionCatalogReference[];
		}
	>();
	const add = (reference: SessionCatalogReference) => {
		const environment = environmentEntityRef(reference.sessionId ?? reference.sessionFile ?? "").environment;
		const key = environmentKey(environment);
		const group = groups.get(key) ?? { environment, references: [] };
		group.references.push(reference);
		groups.set(key, group);
	};
	for (const member of saved.workspace.members)
		add({ sessionId: member.sessionId, sessionFile: member.file });
	for (const sessionId of saved.pinnedSessions)
		if (!saved.workspace.members.some((member) => member.sessionId === sessionId)) add({ sessionId });
	for (const { environment, references } of groups.values()) {
		for (let i = 0; i < references.length; i += 100) {
			try {
				const results = await getExecutionApi(environment).verifySessionCatalog({
					references: references.slice(i, i + 100),
				});
				if (useSessionWorkspaceStore.getState().epoch !== epoch) return;
				for (const item of results) {
					if (item.status === "present" && item.meta)
						useProjectsStore.getState().mergeKnownSessions([item.meta]);
					if (item.status !== "missing" && item.status !== "archived") continue;
					const member = saved.workspace.members.find(
						(m) => m.file === item.reference.sessionFile && m.sessionId === item.reference.sessionId,
					);
					if (
						member &&
						useSessionWorkspaceStore
							.getState()
							.members.some((m) => m.file === member.file && m.sessionId === member.sessionId)
					)
						useSessionWorkspaceStore.getState().removeMember(member.file);
					const id = item.meta?.sessionId ?? item.reference.sessionId;
					if (
						id &&
						saved.pinnedSessions.includes(id) &&
						useUiPreferencesStore.getState().pinnedSessions === pinnedAtStart
					) {
						useUiPreferencesStore.getState().unpin(id);
						pinnedAtStart = useUiPreferencesStore.getState().pinnedSessions;
					}
				}
			} catch {
				// Offline and failed batches retain their saved identities and preferences.
			}
		}
	}
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
