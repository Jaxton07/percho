import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	dir: "",
	packaged: true,
	sdkHandlers: new Map<string, (...args: any[]) => void>(),
	appHandlers: new Map<string, (...args: any[]) => void>(),
	nativeHandlers: new Map<string, (...args: any[]) => void>(),
	updater: {
		logger: null as any,
		autoDownload: true,
		autoInstallOnAppQuit: true,
		on: vi.fn(),
		checkForUpdates: vi.fn(),
		downloadUpdate: vi.fn(),
		quitAndInstall: vi.fn(),
	},
}));
vi.mock("node:module", () => ({ createRequire: () => () => ({ autoUpdater: fake.updater }) }));
vi.mock("node:child_process", () => ({
	execFile: vi.fn((_file, _args, _options, callback) =>
		callback(null, "", "Authority=Developer ID Application\nTeamIdentifier=TEST"),
	),
}));
vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return fake.packaged;
		},
		getVersion: () => "0.6.4",
		getPath: (name: string) =>
			name === "exe" ? join(fake.dir, "Percho.app/Contents/MacOS/Percho") : fake.dir,
		on: (event: string, handler: (...args: any[]) => void) => fake.appHandlers.set(event, handler),
	},
	autoUpdater: {
		on: (event: string, handler: (...args: any[]) => void) => fake.nativeHandlers.set(event, handler),
	},
}));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.local/tmp/updater-test");
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	mkdirSync(root, { recursive: true });
	fake.dir = mkdtempSync(join(root, "case-"));
	fake.packaged = true;
	fake.sdkHandlers.clear();
	fake.appHandlers.clear();
	fake.nativeHandlers.clear();
	fake.updater.on.mockImplementation((event, handler) => fake.sdkHandlers.set(event, handler));
	fake.updater.quitAndInstall.mockReset();
	fake.updater.checkForUpdates.mockResolvedValue(null);
	fake.updater.downloadUpdate.mockResolvedValue([]);
});
afterEach(() => rmSync(fake.dir, { recursive: true, force: true }));
const log = () => readFileSync(join(fake.dir, "update-diagnostics/updater.jsonl"), "utf8");
const attempt = () =>
	JSON.parse(readFileSync(join(fake.dir, "update-diagnostics/install-attempt.json"), "utf8"));

describe("updater diagnostic wiring", () => {
	it("connects SDK logger and emits bounded metadata without changing download policy", async () => {
		const updater = await import("./updater");
		await updater.initUpdater();
		expect(fake.updater.autoDownload).toBe(false);
		expect(fake.updater.autoInstallOnAppQuit).toBe(true);
		fake.updater.logger.info("Downloading https://user:secret@host/file?token=private");
		fake.sdkHandlers.get("update-available")?.({ version: "0.6.5", files: [{ sha512: "hash", size: 123 }] });
		fake.sdkHandlers.get("update-downloaded")?.({ version: "0.6.5", downloadedFile: "installer.exe" });
		expect(log()).toContain("hash");
		expect(log()).toContain("installer.exe");
		expect(log()).not.toContain("secret");
		expect(log()).not.toContain("private");
	});

	it("persists explicit handoff before quitAndInstall, preserves native handoff and app exit events", async () => {
		const updater = await import("./updater");
		await updater.initUpdater();
		fake.sdkHandlers.get("update-downloaded")?.({ version: "0.6.5" });
		fake.updater.quitAndInstall.mockImplementation(() => {
			expect(attempt().trigger).toBe("explicit");
		});
		updater.installUpdate();
		fake.nativeHandlers.get("before-quit-for-update")?.();
		fake.appHandlers.get("before-quit")?.();
		fake.appHandlers.get("quit")?.({}, 0);
		expect(attempt().trigger).toBe("explicit");
		expect(log()).toContain("before-quit-for-update");
		expect(log()).toContain("app-quit");
	});

	it("records automatic install-on-quit but no handoff on an ordinary quit", async () => {
		const updater = await import("./updater");
		await updater.initUpdater();
		fake.appHandlers.get("before-quit")?.();
		expect(updater.getUpdateDiagnostics().previousInstall).toBe("none");
		fake.sdkHandlers.get("update-downloaded")?.({ version: "0.6.5" });
		fake.appHandlers.get("before-quit")?.();
		expect(attempt().trigger).toBe("app-quit");
	});

	it("keeps errors after download visible in logs while preserving the existing UI-state policy", async () => {
		const updater = await import("./updater");
		await updater.initUpdater();
		const states: string[] = [];
		updater.onUpdateState((state) => states.push(state.phase));
		fake.sdkHandlers.get("update-downloaded")?.({ version: "0.6.5" });
		fake.sdkHandlers.get("error")?.(new Error("installer spawn denied"));
		expect(states).toEqual(["downloaded"]);
		expect(log()).toContain("installer spawn denied");
		expect(log()).toContain("update-error");
	});

	it("records rejected check/download operations", async () => {
		const updater = await import("./updater");
		await updater.initUpdater();
		fake.updater.checkForUpdates.mockRejectedValue(new Error("offline"));
		await updater.checkForUpdates();
		fake.sdkHandlers.get("update-available")?.({ version: "0.6.5" });
		fake.updater.downloadUpdate.mockRejectedValue(new Error("write denied"));
		await updater.downloadUpdate();
		expect(log()).toContain("check-rejected");
		expect(log()).toContain("download-rejected");
	});

	it("dev never starts updates but still supports diagnostic export", async () => {
		fake.packaged = false;
		const updater = await import("./updater");
		await updater.initUpdater();
		updater.installUpdate();
		expect(fake.updater.quitAndInstall).not.toHaveBeenCalled();
		expect(fake.sdkHandlers.size).toBe(0);
		expect(updater.getUpdateDiagnostics().previousInstall).toBe("none");
	});
});
