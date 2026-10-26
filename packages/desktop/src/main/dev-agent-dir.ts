import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { type LocalStorageSelection, selectLocalStorage } from "../../../backend/src/storage/path-policy";

// Must run before SDK imports. No agent/userData mkdir, seeding, or legacy fallback here.
if (!app.isPackaged) app.setPath("userData", `${app.getPath("userData")}-dev`);
export let localStorageSelection: LocalStorageSelection | undefined;
export let localStorageSelectionError: Error | undefined;
try {
	localStorageSelection = selectLocalStorage(homedir(), app.isPackaged, process.env);
	process.env.PI_CODING_AGENT_DIR = localStorageSelection.target;
} catch (error) {
	localStorageSelectionError = error instanceof Error ? error : new Error(String(error));
	// Imports must never discover the CLI root, even on a rejected launch. Backend stays unconstructed.
	process.env.PI_CODING_AGENT_DIR = join(app.getPath("userData"), ".rejected-agent");
}
