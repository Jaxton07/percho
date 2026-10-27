import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataset: Record<string, string> = {};
const remove = vi.fn();
const storage = new Map<string, string>();
beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.clearAllMocks();
	for (const key of Object.keys(dataset)) delete dataset[key];
	storage.clear();
	vi.stubGlobal("document", { documentElement: { dataset }, getElementById: () => ({ remove }) });
	vi.stubGlobal("window", { setTimeout, matchMedia: () => ({ matches: false }) });
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => storage.get(key),
		setItem: (key: string, value: string) => storage.set(key, value),
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("one continuous startup splash", () => {
	it("never exits while data checks, a choice or migration are still pending", async () => {
		const splash = await import("./splash");
		splash.initSplash();
		splash.finishSplash();
		vi.advanceTimersByTime(30_000);
		expect(dataset.appReady).toBeUndefined();
		expect(remove).not.toHaveBeenCalled();
	});
	it("ends once on the original clock and cleans the startup host before revealing workbench", async () => {
		const splash = await import("./splash");
		const exit = vi.fn(() => expect(dataset.appReady).toBeUndefined());
		splash.onSplashExit(exit);
		splash.initSplash();
		vi.advanceTimersByTime(1_500);
		splash.releaseSplash();
		splash.finishSplash();
		splash.finishSplash();
		vi.advanceTimersByTime(999);
		expect(dataset.appReady).toBeUndefined();
		vi.advanceTimersByTime(1);
		expect(dataset.appReady).toBe("true");
		expect(exit).toHaveBeenCalledOnce();
		vi.runAllTimers();
		expect(remove).toHaveBeenCalledOnce();
	});
	it("does not restart the minimum duration after a slow data check", async () => {
		const splash = await import("./splash");
		splash.initSplash();
		vi.advanceTimersByTime(10_000);
		splash.releaseSplash();
		splash.finishSplash();
		vi.advanceTimersByTime(0);
		expect(dataset.appReady).toBe("true");
	});
	it("leaves setup directly instead of replaying the brand animation", async () => {
		const splash = await import("./splash");
		dataset.startupView = "setup";
		splash.initSplash();
		splash.releaseSplash();
		splash.finishSplash();
		vi.advanceTimersByTime(0);
		expect(dataset.appReady).toBe("true");
		vi.advanceTimersByTime(300);
		expect(remove).toHaveBeenCalledOnce();
	});
	it("a reload that has already played still waits for preparation before showing the workbench", async () => {
		storage.set("pi-splash-played", "1");
		const splash = await import("./splash");
		splash.initSplash();
		expect(dataset.splashStatic).toBe("true");
		expect(dataset.appReady).toBeUndefined();
		splash.releaseSplash();
		splash.finishSplash();
		vi.advanceTimersByTime(0);
		expect(dataset.appReady).toBe("true");
	});
});
