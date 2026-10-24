import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { environmentEntityKey } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root } }));
vi.mock("@percho/backend", async () => ({
	JsonStore: (await import("../../../backend/src/json-store")).JsonStore,
}));

import {
	loadEnvironmentUiState,
	saveEnvironmentUiState,
	setEnvironmentUiAuthorization,
} from "./environment-ui-state";

const env = { kind: "ssh", connectionId: "fixture", environmentId: "remote" } as const;
const state = () => ({
	version: 1,
	projects: [environmentEntityKey(env, "/private/project")],
	dailyDirs: [],
	pinnedSessions: [],
	pinnedProjects: [],
	expandedGroups: [],
	expandedGroupsTouched: true,
	lastCwd: null,
	workspace: { members: [], activeFile: null, recentFile: null },
	catalog: [],
});
beforeEach(async () => {
	const parent = resolve("../../.local/tmp/ssh-remote-runtime/plugin-state-tests");
	await mkdir(parent, { recursive: true });
	fixture.root = await mkdtemp(join(parent, "case-"));
});
afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});
describe("remote navigation data exposure", () => {
	it("does not return cached remote data before workbench approval", async () => {
		await writeFile(join(fixture.root, "environment-ui-state.json"), JSON.stringify(state()));
		let release!: () => void,
			settled = false;
		const authorize = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		setEnvironmentUiAuthorization(authorize);
		const loading = loadEnvironmentUiState().then((value) => {
			settled = true;
			return value;
		});
		await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
		expect(settled).toBe(false);
		release();
		expect((await loading)?.projects).toEqual(state().projects);
	});
	it("refusal cannot overwrite retained remote navigation with a local-only fallback", async () => {
		const path = join(fixture.root, "environment-ui-state.json"),
			original = JSON.stringify(state());
		await writeFile(path, original);
		setEnvironmentUiAuthorization(async () => {
			throw new Error("declined");
		});
		await expect(loadEnvironmentUiState()).rejects.toThrow("declined");
		await expect(saveEnvironmentUiState({ ...state(), projects: ["/local"] })).rejects.toThrow("declined");
		expect(await readFile(path, "utf8")).toBe(original);
	});
});
