import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiPluginsConfig } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	root: "",
	handlers: {} as Record<string, (input: any) => Promise<unknown>>,
	pausedReads: 0,
	captured: [] as UiPluginsConfig[],
	releases: [] as Array<() => void>,
	onCaptured: () => {},
	send: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => state.root }, shell: { openPath: vi.fn() } }));
vi.mock("../../../main/ipc/index", () => ({ sendToRenderer: state.send }));
vi.mock("../api", () => ({
	getPi: () => ({
		uiPluginsGetConfig: () => invoke("uiPluginsGetConfig", undefined),
		uiPluginsList: () => invoke("uiPluginsList", undefined),
	}),
}));
vi.mock("../../../main/ipc/invoke", () => ({
	registerInvokeHandlers: (_table: unknown, handlers: typeof state.handlers) => {
		state.handlers = handlers;
	},
}));
vi.mock("../../../main/ui-plugins/seeder", () => ({
	pluginsDir: () => join(state.root, "plugins"),
	builtinPluginsDir: () => join(state.root, "builtin"),
}));
// Only scheduling is controlled: every read and write still uses the real config + JsonStore.
vi.mock("../../../main/ui-plugins/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../main/ui-plugins/config")>();
	return {
		...actual,
		loadUiPluginsConfig: async () => {
			const pause = state.pausedReads > 0;
			if (pause) state.pausedReads--;
			const value = await actual.loadUiPluginsConfig();
			if (pause) {
				await new Promise<void>((resolve) => {
					state.releases.push(resolve);
					state.captured.push(value);
					state.onCaptured();
				});
			}
			return value;
		},
	};
});

import { registerUiPluginsIpc } from "../../../main/ipc/ui-plugins";
import { loadUiPluginsConfig } from "../../../main/ui-plugins/config";
import { UiPluginManager } from "../../../main/ui-plugins/manager";
import { useUiPluginsStore } from "./ui-plugins";

let manager: UiPluginManager;
beforeEach(async () => {
	state.root = await mkdtemp(join(tmpdir(), "plugin-baseline-"));
	state.pausedReads = 0;
	state.captured = [];
	state.releases = [];
	state.send.mockClear();
	for (const name of ["alpha", "beta"]) {
		const dir = join(state.root, "plugins", name);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "plugin.json"),
			JSON.stringify({
				name,
				perchoUi: 1,
				main: "src/index.ts",
				slots: { "chat.todo-panel": "Todo" },
			}),
		);
	}
	manager = new UiPluginManager();
	await manager.scanAll();
	registerUiPluginsIpc(manager);
});
afterEach(async () => {
	for (const release of state.releases.splice(0)) release();
	await rm(state.root, { recursive: true, force: true });
});
function barrier(reads: number): Promise<void> {
	state.pausedReads = reads;
	return new Promise((resolve) => {
		state.onCaptured = () => {
			if (state.captured.length === reads) resolve();
		};
	});
}
function releaseReads() {
	for (const release of state.releases.splice(0)) release();
}
function invoke(name: string, input: unknown) {
	const handler = state.handlers[name];
	if (!handler) throw new Error(`Missing handler: ${name}`);
	return handler(input);
}

describe("V01–V02 current configuration race characteristics (flip in ticket 02)", () => {
	it("two plugin commands read the same snapshot and deterministically lose one enable", async () => {
		const captured = barrier(2);
		const first = invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled: true });
		const second = invoke("uiPluginsSetPluginEnabled", { name: "beta", enabled: true });
		await captured;
		expect(state.captured[0]).toEqual(state.captured[1]);
		releaseReads();
		await Promise.all([first, second]);
		const config = await loadUiPluginsConfig();
		expect(Object.keys(config.plugins)).toHaveLength(1);
		expect(Object.values(config.plugins)[0]).toEqual({ enabled: true, trusted: true });
		expect(state.send).toHaveBeenCalledTimes(2);
	});
	it("two slot assignments read the same snapshot and deterministically lose one assignment", async () => {
		const captured = barrier(2);
		const first = invoke("uiPluginsAssignSlot", { slot: "chat.todo-panel", pluginName: "alpha" });
		const second = invoke("uiPluginsAssignSlot", { slot: "chat.tool-call-card", pluginName: "beta" });
		await captured;
		expect(state.captured[0]).toEqual(state.captured[1]);
		releaseReads();
		await Promise.all([first, second]);
		expect(Object.keys((await loadUiPluginsConfig()).assignments)).toHaveLength(1);
	});
	it("a late scan publishes its old config after a newer successful commit and config event", async () => {
		const captured = barrier(1);
		const staleScan = manager.scanAll();
		await captured;
		await invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled: true });
		expect(manager.info("alpha")?.enabled).toBe(true);
		expect(state.send).toHaveBeenCalledTimes(1);
		releaseReads();
		await staleScan;
		expect((await loadUiPluginsConfig()).plugins.alpha?.enabled).toBe(true);
		expect(manager.info("alpha")?.enabled).toBe(false);
		// Real renderer store pulls both public IPC data sources after the late scan.
		await useUiPluginsStore.getState().loadAll();
		expect(useUiPluginsStore.getState().config.plugins.alpha?.enabled).toBe(true);
		expect(useUiPluginsStore.getState().plugins.find((plugin) => plugin.name === "alpha")?.enabled).toBe(
			false,
		);
	});
	it("corrupted config rejects a command without a success event or overwrite", async () => {
		const file = join(state.root, "ui-plugins.json");
		await writeFile(file, "{broken");
		await expect(invoke("uiPluginsSetEnabled", { enabled: true })).rejects.toThrow();
		expect(state.send).not.toHaveBeenCalled();
		expect(await readFile(file, "utf8")).toBe("{broken");
	});
});
