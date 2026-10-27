import type { StorageStartupState } from "@percho/shared";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	render: vi.fn(),
	unmount: vi.fn(),
	remove: vi.fn(),
	append: vi.fn(),
	importWorkbench: vi.fn(),
	off: vi.fn(),
	get: vi.fn(),
	onStatus: undefined as ((state: StorageStartupState) => void) | undefined,
	onExit: undefined as (() => void) | undefined,
}));
vi.mock("react-dom/client", () => ({
	createRoot: () => ({ render: fixture.render, unmount: fixture.unmount }),
}));
vi.mock("./components/startup/StorageStartup", () => ({ StorageStartup: () => null }));
vi.mock("./workbench", () => {
	fixture.importWorkbench();
	return {};
});
vi.mock("./i18n", () => ({
	translate: () => "Preparing",
	useI18nStore: { getState: () => ({ language: "en" }) },
}));
vi.mock("./splash", () => ({
	setSplashMessage: vi.fn(),
	onSplashExit: (fn: () => void) => {
		fixture.onExit = fn;
	},
}));

const dataset: Record<string, string> = {};
const state = (phase: StorageStartupState["phase"]): StorageStartupState => ({
	phase,
	target: "/private-agent",
	source: null,
	files: 0,
	bytes: 0,
	external: [],
});
const flush = async () => {
	await new Promise((resolve) => setImmediate(resolve));
};
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	for (const key of Object.keys(dataset)) delete dataset[key];
	fixture.get.mockResolvedValue(state("ready"));
	vi.stubGlobal("React", React);
	vi.stubGlobal("document", {
		documentElement: { dataset },
		createElement: () => ({ remove: fixture.remove }),
		body: { append: fixture.append },
	});
	vi.stubGlobal("window", {
		pi: {
			storageStartupGet: fixture.get,
			storageStartupAct: vi.fn(),
			onStorageStartup: (fn: typeof fixture.onStatus) => {
				fixture.onStatus = fn;
				return fixture.off;
			},
		},
	});
});
afterEach(() => vi.unstubAllGlobals());
describe("storage to workbench handoff", () => {
	it("renders no migration page for a prepared user and waits for business IPC permission", async () => {
		const { renderStorageStartup } = await import("./storage-startup");
		renderStorageStartup();
		await flush();
		expect(fixture.render.mock.calls.every(([element]) => element === null)).toBe(true);
		expect(dataset.startupView).toBe("splash");
		expect(fixture.importWorkbench).not.toHaveBeenCalled();
		fixture.onStatus?.(state("launching"));
		await flush();
		expect(fixture.importWorkbench).toHaveBeenCalledOnce();
		fixture.onStatus?.(state("launching"));
		await flush();
		expect(fixture.importWorkbench).toHaveBeenCalledOnce();
		fixture.onExit?.();
		expect(fixture.off).toHaveBeenCalledOnce();
		expect(fixture.unmount).toHaveBeenCalledOnce();
		expect(fixture.remove).toHaveBeenCalledOnce();
	});
	it("a late initial query cannot replace a newer choice, and setup stays until workbench exit", async () => {
		let resolve!: (state: StorageStartupState) => void;
		fixture.get.mockReturnValue(
			new Promise<StorageStartupState>((done) => {
				resolve = done;
			}),
		);
		const { renderStorageStartup } = await import("./storage-startup");
		renderStorageStartup();
		fixture.onStatus?.(state("choice"));
		resolve(state("inspecting"));
		await flush();
		expect(dataset.startupView).toBe("setup");
		expect(fixture.render.mock.lastCall?.[0]?.props.state.phase).toBe("choice");
		fixture.onStatus?.(state("ready"));
		expect(fixture.unmount).not.toHaveBeenCalled();
		expect(dataset.startupView).toBe("setup");
	});
});
