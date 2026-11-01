import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	packages: [] as { source: string; scope: "user" | "project"; installedPath?: string }[],
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => "unused-agent-dir",
	SettingsManager: { create: () => ({}) },
	DefaultPackageManager: class {
		listConfiguredPackages() {
			return sdk.packages;
		}
	},
}));

import { PackageAdmin } from "../src/packages/admin";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let dir: string;
let admin: PackageAdmin;
const fetchMock = vi.fn<typeof fetch>();
beforeEach(async () => {
	const root = resolve(".local/tmp/package-update-tests");
	await mkdir(root, { recursive: true });
	dir = await mkdtemp(join(root, "run-"));
	sdk.packages = [];
	admin = new PackageAdmin({ reloadIdleSessions: vi.fn() });
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset().mockImplementation(async () => Response.json({ version: "3.0.0" }));
});
afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await rm(dir, { recursive: true, force: true });
});

async function installed(folder: string, version: unknown) {
	const path = join(dir, folder);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "package.json"), JSON.stringify({ version }));
	return path;
}

describe("PackageAdmin version reads and checks", () => {
	it("uses SDK paths for user, project and legacy installs; deduplicates only registry requests", async () => {
		sdk.packages = [
			{ source: "npm:demo", scope: "user", installedPath: await installed("user", "1.0.0") },
			{ source: "npm:demo", scope: "project", installedPath: await installed("project", "2.0.0") },
			{ source: "npm:demo@2.1.0", scope: "project", installedPath: await installed("pinned", "2.1.0") },
			{ source: "npm:@scope/demo", scope: "user", installedPath: await installed("legacy", "3.0.0") },
		];
		const configured = await admin.listConfiguredPackages();
		expect(configured.map((p) => p.installedVersion)).toEqual(["1.0.0", "2.0.0", "2.1.0", "3.0.0"]);
		expect(fetchMock).not.toHaveBeenCalled();
		const updates = await admin.checkPackageUpdates();
		expect(updates.map((p) => [p.source, p.scope, p.installed, p.hasUpdate])).toEqual([
			["npm:demo", "user", "1.0.0", true],
			["npm:demo", "project", "2.0.0", true],
			["npm:demo@2.1.0", "project", "2.1.0", true],
			["npm:@scope/demo", "user", "3.0.0", false],
		]);
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"https://registry.npmjs.org/demo/latest",
			"https://registry.npmjs.org/@scope%2Fdemo/latest",
		]);
	});

	it("skips non-npm sources and tolerates missing or malformed local metadata", async () => {
		const malformed = await installed("malformed", "1.0.0");
		await writeFile(join(malformed, "package.json"), "{");
		sdk.packages = [
			{ source: "npm:missing", scope: "project" },
			{ source: "npm:malformed", scope: "user", installedPath: malformed },
			{ source: "npm:invalid", scope: "user", installedPath: await installed("invalid", 42) },
			{ source: "git:example/demo", scope: "user" },
		];
		expect((await admin.checkPackageUpdates()).map((p) => [p.installed, p.hasUpdate])).toEqual([
			["", false],
			["", false],
			["", false],
		]);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("network failures preserve installed versions and do not hide successful checks", async () => {
		const path = await installed("demo", "1.0.0");
		sdk.packages = ["good", "offline", "missing", "bad-json"].map((name) => ({
			source: `npm:${name}`,
			scope: "user",
			installedPath: path,
		}));
		fetchMock.mockImplementation(async (url) => {
			if (String(url).includes("offline")) throw new Error("offline");
			if (String(url).includes("missing")) return new Response(null, { status: 404 });
			if (String(url).includes("bad-json")) return new Response("{");
			return Response.json({ version: "2.0.0" });
		});
		const updates = await admin.checkPackageUpdates();
		expect(updates.map((p) => p.installed)).toEqual(Array(4).fill("1.0.0"));
		expect(updates.map((p) => p.hasUpdate)).toEqual([true, false, false, false]);
	});

	it("limits concurrent requests while checking every unique package", async () => {
		sdk.packages = Array.from({ length: 9 }, (_, i) => ({ source: `npm:demo-${i}`, scope: "user" }));
		const started = deferred<void>();
		const release = deferred<void>();
		let active = 0;
		let maxActive = 0;
		fetchMock.mockImplementation(async () => {
			active++;
			maxActive = Math.max(active, maxActive);
			if (active === 4) started.resolve();
			await release.promise;
			active--;
			return Response.json({ version: "2.0.0" });
		});
		const pending = admin.checkPackageUpdates();
		await started.promise;
		expect(fetchMock).toHaveBeenCalledTimes(4);
		release.resolve();
		expect(await pending).toHaveLength(9);
		expect(maxActive).toBe(4);
		expect(fetchMock).toHaveBeenCalledTimes(9);
	});

	it("shares one timeout budget and stops starting requests after it expires", async () => {
		sdk.packages = Array.from({ length: 9 }, (_, i) => ({ source: `npm:demo-${i}`, scope: "user" }));
		const controller = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		const started = deferred<void>();
		fetchMock.mockImplementation(
			(_url, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
					if (fetchMock.mock.calls.length === 4) started.resolve();
				}),
		);
		const pending = admin.checkPackageUpdates();
		await started.promise;
		controller.abort();
		const updates = await pending;
		expect(updates).toHaveLength(9);
		expect(updates.every((p) => p.latest === "" && !p.hasUpdate)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});
});
