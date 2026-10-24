import { join } from "node:path";
import { JsonStore } from "@percho/backend";
import { type EnvironmentUiState, parseEnvironmentUiState } from "@percho/shared";
import { app } from "electron";

const store = () =>
	new JsonStore<unknown>({
		path: join(app.getPath("userData"), "environment-ui-state.json"),
		defaultValue: () => null,
	});
export async function loadEnvironmentUiState(): Promise<EnvironmentUiState | null> {
	return parseEnvironmentUiState(await store().read());
}
export async function saveEnvironmentUiState(value: unknown): Promise<void> {
	const state = parseEnvironmentUiState(value);
	if (!state) throw new Error("Invalid environment navigation preferences");
	await store().update(() => state);
}
