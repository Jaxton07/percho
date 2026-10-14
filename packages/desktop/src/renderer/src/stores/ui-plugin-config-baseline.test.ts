import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiPluginsConfig } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type BuildResult = Awaited<ReturnType<typeof import("../../../main/ui-plugins/build").buildPlugin>>;

const state = vi.hoisted(() => ({
	root: "",
	handlers: {} as Record<string, (input: any) => unknown>,
	pauseRead: false,
	captured: [] as UiPluginsConfig[],
	releases: [] as Array<() => void>,
	pending: [] as Promise<unknown>[],
	failWrite: false,
	writes: [] as string[],
	commandStarts: 0,
	holdBuild: false,
	heldBuilds: [] as Array<{ dir: string; resolve: (result: BuildResult) => void }>,
	send: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => state.root }, shell: { openPath: vi.fn() } }));
vi.mock("../../../main/ipc/send", () => ({ sendToRenderer: state.send }));
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
// Fault injection at the real atomic-rename IO boundary, not a replacement update implementation.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: async (from: string, to: string) => {
			if (to === join(state.root, "ui-plugins.json")) {
				if (state.failWrite) throw new Error("injected rename failure");
				state.writes.push(to);
			}
			return actual.rename(from, to);
		},
	};
});
// Control the external build-result seam; all config, scan and renderer pull logic stays real.
vi.mock("../../../main/ui-plugins/build", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../main/ui-plugins/build")>();
	return {
		...actual,
		buildPlugin: (...args: Parameters<typeof actual.buildPlugin>) => {
			if (!state.holdBuild) return actual.buildPlugin(...args);
			return new Promise<BuildResult>((resolve) => {
				state.heldBuilds.push({ dir: args[0], resolve });
			});
		},
	};
});
// Only the scan read's return time is controlled. Config commands and JsonStore are real.
vi.mock("../../../main/ui-plugins/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../main/ui-plugins/config")>();
	return {
		...actual,
		updateUiPluginsConfig: (command: Parameters<typeof actual.updateUiPluginsConfig>[0]) => {
			state.commandStarts++;
			return actual.updateUiPluginsConfig(command);
		},
		loadUiPluginsConfig: async () => {
			const pause = state.pauseRead;
			state.pauseRead = false;
			const value = await actual.loadUiPluginsConfig();
			if (pause)
				await new Promise<void>((resolve) => {
					state.releases.push(resolve);
					state.captured.push(value);
				});
			return value;
		},
	};
});

import { registerUiPluginsIpc } from "../../../main/ipc/ui-plugins";
import { loadUiPluginsConfig, updateUiPluginsConfig } from "../../../main/ui-plugins/config";
import { UiPluginManager } from "../../../main/ui-plugins/manager";
import { useUiPluginsStore } from "./ui-plugins";

let manager: UiPluginManager;
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(`${label}: stalled; captures=${state.captured.length}, writes=${state.writes.length}`),
				),
			2000,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function track<T>(promise: Promise<T>): Promise<T> {
	state.pending.push(promise);
	return promise;
}
function invoke(name: string, input: unknown): Promise<unknown> {
	const handler = state.handlers[name];
	if (!handler) throw new Error(`Missing handler: ${name}`);
	return track(Promise.resolve(handler(input)));
}
beforeEach(async () => {
	state.root = await mkdtemp(join(tmpdir(), "plugin-config-"));
	state.pauseRead = false;
	state.captured = [];
	state.releases = [];
	state.pending = [];
	state.failWrite = false;
	state.writes = [];
	state.commandStarts = 0;
	state.holdBuild = false;
	state.heldBuilds = [];
	state.send.mockClear();
	for (const name of ["alpha", "beta"]) {
		const dir = join(state.root, "plugins", name);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "plugin.json"),
			JSON.stringify({ name, perchoUi: 1, main: "src/index.ts", slots: { "chat.todo-panel": "Todo" } }),
		);
	}
	manager = new UiPluginManager();
	await manager.scanAll();
	registerUiPluginsIpc(manager);
	useUiPluginsStore.setState({
		config: { enabled: false, plugins: {}, assignments: {} },
		plugins: [],
		loadErrors: {},
	});
});
afterEach(async () => {
	for (const release of state.releases.splice(0)) release();
	for (const build of state.heldBuilds.splice(0)) build.resolve({ ok: false, error: "test cleanup" });
	await bounded(Promise.allSettled(state.pending), "cleanup");
	await rm(state.root, { recursive: true, force: true });
});
async function assertRendererAligned() {
	await bounded(useUiPluginsStore.getState().loadAll(), "renderer pull");
	const config = await loadUiPluginsConfig();
	expect(useUiPluginsStore.getState().config).toEqual(config);
	expect(useUiPluginsStore.getState().plugins).toEqual(manager.list());
	for (const plugin of manager.list()) {
		expect(plugin.enabled).toBe(config.plugins[plugin.name]?.enabled ?? false);
		expect(plugin.trusted).toBe(config.plugins[plugin.name]?.trusted ?? false);
	}
}

describe("ticket 02 atomic commands and ordered cache publication", () => {
	it("real JsonStore preserves two concurrent commands even without manager serialization", async () => {
		await bounded(
			Promise.all([
				updateUiPluginsConfig({ kind: "set-plugin-enabled", name: "alpha", enabled: true }),
				updateUiPluginsConfig({ kind: "set-plugin-enabled", name: "beta", enabled: true }),
				updateUiPluginsConfig({ kind: "assign-slot", slot: "chat.todo-panel", pluginName: "alpha" }),
				updateUiPluginsConfig({ kind: "assign-slot", slot: "chat.subagent-card", pluginName: "beta" }),
			]),
			"atomic commands",
		);
		expect(await loadUiPluginsConfig()).toMatchObject({
			plugins: { alpha: { enabled: true, trusted: true }, beta: { enabled: true, trusted: true } },
			assignments: { "chat.todo-panel": "alpha", "chat.subagent-card": "beta" },
		});
	});
	it("concurrent IPC enables and assignments preserve all targets and renderer state", async () => {
		await bounded(
			Promise.all([
				invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled: true }),
				invoke("uiPluginsSetPluginEnabled", { name: "beta", enabled: true }),
				invoke("uiPluginsAssignSlot", { slot: "chat.todo-panel", pluginName: "alpha" }),
				invoke("uiPluginsAssignSlot", { slot: "chat.tool-call-card", pluginName: "beta" }),
			]),
			"IPC commands",
		);
		expect(Object.keys((await loadUiPluginsConfig()).plugins).sort()).toEqual(["alpha", "beta"]);
		expect((await loadUiPluginsConfig()).assignments).toEqual({
			"chat.todo-panel": "alpha",
			"chat.tool-call-card": "beta",
		});
		expect(state.send).toHaveBeenCalledTimes(4);
		await assertRendererAligned();
	});
	it("same-target order is submission order; disable preserves trust and cancellation deletes only its key", async () => {
		await writeFile(
			join(state.root, "ui-plugins.json"),
			JSON.stringify({
				enabled: false,
				plugins: {},
				assignments: { legacy: "missing", "chat.subagent-card": "removed-plugin" },
			}),
		);
		await bounded(
			Promise.all([
				invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled: true }),
				invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled: false }),
				invoke("uiPluginsSetPluginEnabled", { name: "beta", enabled: false }),
				invoke("uiPluginsAssignSlot", { slot: "chat.todo-panel", pluginName: "alpha" }),
				invoke("uiPluginsAssignSlot", { slot: "chat.todo-panel", pluginName: "beta" }),
				invoke("uiPluginsSetEnabled", { enabled: true }),
				invoke("uiPluginsSetEnabled", { enabled: false }),
			]),
			"ordered commands",
		);
		expect(await loadUiPluginsConfig()).toEqual({
			enabled: false,
			plugins: { alpha: { enabled: false, trusted: true }, beta: { enabled: false, trusted: false } },
			assignments: { legacy: "missing", "chat.subagent-card": "removed-plugin", "chat.todo-panel": "beta" },
		});
		await invoke("uiPluginsAssignSlot", { slot: "chat.todo-panel", pluginName: null });
		expect((await loadUiPluginsConfig()).assignments).toEqual({
			legacy: "missing",
			"chat.subagent-card": "removed-plugin",
		});
		await assertRendererAligned();
	});
	it("invalid parameters or missing enable targets remain no-ops; assigning a missing plugin remains allowed", async () => {
		await invoke("uiPluginsSetEnabled", { enabled: "true" });
		await invoke("uiPluginsSetPluginEnabled", { name: "missing", enabled: true });
		await invoke("uiPluginsAssignSlot", { slot: "unknown-slot", pluginName: "alpha" });
		expect(state.commandStarts).toBe(0);
		expect(state.writes).toHaveLength(0);
		expect(state.send).not.toHaveBeenCalled();
		await invoke("uiPluginsAssignSlot", { slot: "chat.todo-panel", pluginName: "missing" });
		expect((await loadUiPluginsConfig()).assignments).toEqual({ "chat.todo-panel": "missing" });
		await assertRendererAligned();
	});
	it("paused old scan must finish before newer command commits; renderer ultimately sees the new state", async () => {
		state.pauseRead = true;
		const oldScan = track(manager.scanAll());
		await vi.waitFor(() => expect(state.captured, "expected the controlled scan-read seam").toHaveLength(1), {
			timeout: 1500,
		});
		const update = invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled: true });
		await Promise.resolve();
		expect(state.commandStarts).toBe(0);
		expect(state.writes).toHaveLength(0);
		expect(state.send).not.toHaveBeenCalled();
		for (const release of state.releases.splice(0)) release();
		await bounded(Promise.all([oldScan, update]), "scan + update");
		expect(manager.info("alpha")?.enabled).toBe(true);
		expect(state.send).toHaveBeenCalledTimes(1);
		await assertRendererAligned();
	});
	it("corrupted config rejects without success event, overwrite, or poisoning the next command", async () => {
		const file = join(state.root, "ui-plugins.json");
		await writeFile(file, "{broken");
		await expect(invoke("uiPluginsSetEnabled", { enabled: true })).rejects.toThrow();
		expect(state.send).not.toHaveBeenCalled();
		expect(await readFile(file, "utf8")).toBe("{broken");
		await writeFile(file, JSON.stringify({ enabled: false, plugins: {}, assignments: {} }));
		await invoke("uiPluginsSetEnabled", { enabled: true });
		expect(state.send).toHaveBeenCalledTimes(1);
		await assertRendererAligned();
	});
	it.each([
		{ ok: true, enabled: true },
		{ ok: false, enabled: true },
		{ ok: true, enabled: false },
		{ ok: false, enabled: false },
	])(
		"late build ok=$ok preserves committed enabled=$enabled/trusted and newest scan fields",
		async ({ ok, enabled }) => {
			await invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled: !enabled });
			const dir = join(state.root, "plugins", "alpha");
			await mkdir(join(dir, "dist"));
			await writeFile(join(dir, "dist/index.js"), "old artifact");
			state.holdBuild = true;
			const building = track(manager.ensureBuilt("alpha", true));
			await vi.waitFor(() => expect(state.heldBuilds, "expected the build-result seam").toHaveLength(1), {
				timeout: 1500,
			});
			await writeFile(
				join(dir, "plugin.json"),
				JSON.stringify({
					name: "alpha",
					version: "2.0",
					perchoUi: 1,
					main: "src/index.ts",
					slots: { "chat.todo-panel": "Todo" },
				}),
			);
			await bounded(
				invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled }),
				"command while build pending",
			);
			expect(manager.info("alpha")).toMatchObject({ enabled, trusted: true, version: "2.0" });
			const held = state.heldBuilds.shift();
			if (!held) throw Error("missing held build");
			expect(held.dir).toBe(dir);
			held.resolve(ok ? { ok: true } : { ok: false, error: "late build failure" });
			expect(await bounded(building, "late build")).toBe(ok);
			expect(manager.info("alpha")).toMatchObject({ enabled, trusted: true, version: "2.0", built: true });
			expect(manager.info("alpha")?.buildError).toBe(ok ? undefined : "late build failure");
			expect(await readFile(join(dir, "dist/index.js"), "utf8")).toBe("old artifact");
			await assertRendererAligned();
		},
	);
	it.each([true, false])("late build ok=%s cannot revive a plugin removed by scan", async (ok) => {
		await invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled: true });
		state.holdBuild = true;
		const building = track(manager.ensureBuilt("alpha", true));
		await vi.waitFor(() => expect(state.heldBuilds, "expected the build-result seam").toHaveLength(1), {
			timeout: 1500,
		});
		await rm(join(state.root, "plugins", "alpha"), { recursive: true });
		await bounded(manager.scanAll(), "scan deleted plugin");
		expect(manager.info("alpha")).toBeNull();
		expect(manager.pluginDirOf("alpha")).toBeNull();
		const held = state.heldBuilds.shift();
		if (!held) throw Error("missing held build");
		held.resolve(ok ? { ok: true } : { ok: false, error: "late removed build" });
		expect(await bounded(building, "removed late build")).toBe(ok);
		expect(manager.info("alpha")).toBeNull();
		expect(manager.list().map((plugin) => plugin.name)).toEqual(["beta"]);
		await assertRendererAligned();
	});
	it("atomic rename failure preserves disk/cache/renderer and emits no success; retry works", async () => {
		await invoke("uiPluginsSetPluginEnabled", { name: "alpha", enabled: true });
		await assertRendererAligned();
		const file = join(state.root, "ui-plugins.json");
		const before = await readFile(file, "utf8");
		const cache = manager.list();
		state.send.mockClear();
		state.failWrite = true;
		await expect(invoke("uiPluginsSetPluginEnabled", { name: "beta", enabled: true })).rejects.toThrow(
			"injected rename failure",
		);
		expect(await readFile(file, "utf8")).toBe(before);
		expect(manager.list()).toEqual(cache);
		expect(state.send).not.toHaveBeenCalled();
		await assertRendererAligned();
		state.failWrite = false;
		await invoke("uiPluginsSetPluginEnabled", { name: "beta", enabled: true });
		expect(state.send).toHaveBeenCalledTimes(1);
		await assertRendererAligned();
	});
});
