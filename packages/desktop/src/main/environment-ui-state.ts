import { join } from "node:path";
import { JsonStore } from "@percho/backend";
import { type EnvironmentUiState, environmentEntityRef, parseEnvironmentUiState } from "@percho/shared";
import { app } from "electron";

const store = () =>
	new JsonStore<unknown>({
		path: join(app.getPath("userData"), "environment-ui-state.json"),
		defaultValue: () => null,
	});
let authorizeRemote: () => Promise<void> = async () => {
	throw new Error("Remote UI authorization is not initialized");
};
export function setEnvironmentUiAuthorization(authorize: () => Promise<void>): void {
	authorizeRemote = authorize;
}
function hasRemote(state: EnvironmentUiState | null): boolean {
	if (!state) return false;
	return [
		...state.projects,
		...state.dailyDirs,
		...state.pinnedSessions,
		...state.pinnedProjects,
		...state.expandedGroups,
		...(state.lastCwd ? [state.lastCwd] : []),
		...state.workspace.members.map((member) => member.file),
		...state.catalog.map((meta) => meta.sessionId),
	].some((key) => environmentEntityRef(key).environment.kind === "ssh");
}
export async function loadEnvironmentUiState(): Promise<EnvironmentUiState | null> {
	const state = parseEnvironmentUiState(await store().read());
	if (hasRemote(state)) await authorizeRemote();
	return state;
}
export async function saveEnvironmentUiState(value: unknown): Promise<void> {
	const state = parseEnvironmentUiState(value);
	if (!state) throw new Error("Invalid environment navigation preferences");
	if (hasRemote(state) || hasRemote(parseEnvironmentUiState(await store().read()))) await authorizeRemote();
	await store().update(() => state);
}
