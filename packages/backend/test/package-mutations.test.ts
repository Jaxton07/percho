import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PackageAdmin } from "../src/packages/admin";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let root: string;
let admin: PackageAdmin;
let operations: Promise<void>[];
let releases: (() => void)[];
const reload = vi.fn();
beforeEach(async () => {
	const base = resolve(".local/tmp/package-mutation-tests");
	await mkdir(base, { recursive: true });
	root = await mkdtemp(join(base, "case-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	await writeFile(join(root, "settings.json"), JSON.stringify({ packages: [] }));
	operations = [];
	releases = [];
	reload.mockReset().mockResolvedValue(undefined);
	admin = new PackageAdmin({ defaultCwd: root, reloadIdleSessions: reload });
	// Keep SDK settings reads, array updates and file persistence real; replace only npm I/O.
	vi.spyOn(DefaultPackageManager.prototype, "install").mockResolvedValue(undefined);
	vi.spyOn(DefaultPackageManager.prototype, "remove").mockResolvedValue(undefined);
});
afterEach(async () => {
	for (const release of releases) release();
	await Promise.allSettled(operations);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});
function gate() {
	const pending = deferred();
	releases.push(pending.resolve);
	return pending;
}
function track(operation: Promise<void>) {
	operations.push(operation);
	return operation;
}
async function packages() {
	return JSON.parse(await readFile(join(root, "settings.json"), "utf8")).packages;
}

it("serializes overlapping installs and retains both persisted records", async () => {
	const started = gate();
	const release = gate();
	vi.mocked(DefaultPackageManager.prototype.install).mockImplementationOnce(async () => {
		started.resolve();
		await release.promise;
	});
	const first = track(admin.installPackage("demo-a"));
	await started.promise;
	const second = track(admin.installPackage("demo-b"));
	expect(DefaultPackageManager.prototype.install).toHaveBeenCalledOnce();
	release.resolve();
	await Promise.all([first, second]);
	expect(await packages()).toEqual(["npm:demo-a", "npm:demo-b"]);
	expect(reload).toHaveBeenCalledTimes(2);
});

it("orders removal after a pending install without resurrecting the removed record", async () => {
	await writeFile(join(root, "settings.json"), JSON.stringify({ packages: ["npm:old"] }));
	const started = gate();
	const release = gate();
	vi.mocked(DefaultPackageManager.prototype.install).mockImplementationOnce(async () => {
		started.resolve();
		await release.promise;
	});
	const first = track(admin.installPackage("new"));
	await started.promise;
	const second = track(admin.removePackage("npm:old", "user"));
	expect(DefaultPackageManager.prototype.remove).not.toHaveBeenCalled();
	release.resolve();
	await Promise.all([first, second]);
	expect(await packages()).toEqual(["npm:new"]);
});

it("reports a failed operation without blocking the next queued install", async () => {
	const failure = new Error("npm failure");
	vi.mocked(DefaultPackageManager.prototype.install).mockRejectedValueOnce(failure);
	const first = track(admin.installPackage("bad"));
	const second = track(admin.installPackage("good"));
	await expect(first).rejects.toBe(failure);
	await second;
	expect(await packages()).toEqual(["npm:good"]);
	expect(reload).toHaveBeenCalledOnce();
});

it("waits for settings flush before reloading or starting the next mutation", async () => {
	const entered = gate();
	const release = gate();
	const flush = SettingsManager.prototype.flush;
	vi.spyOn(SettingsManager.prototype, "flush").mockImplementationOnce(async function (this: SettingsManager) {
		entered.resolve();
		await release.promise;
		await flush.call(this);
	});
	const first = track(admin.installPackage("demo-a"));
	const second = track(admin.installPackage("demo-b"));
	await entered.promise;
	expect(DefaultPackageManager.prototype.install).toHaveBeenCalledOnce();
	expect(reload).not.toHaveBeenCalled();
	release.resolve();
	await Promise.all([first, second]);
	expect(await packages()).toEqual(["npm:demo-a", "npm:demo-b"]);
});

it("surfaces SDK persistence errors instead of reporting success and reloading", async () => {
	vi.mocked(DefaultPackageManager.prototype.install).mockImplementationOnce(async () => {
		const path = join(root, "settings.json");
		await rm(path);
		await mkdir(path);
	});
	await expect(track(admin.installPackage("demo"))).rejects.toThrow();
	expect(reload).not.toHaveBeenCalled();
});
