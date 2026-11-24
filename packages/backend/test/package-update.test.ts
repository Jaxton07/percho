import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NPM_NOT_FOUND_SENTINEL } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the SDK package manager is mocked: no npm spawn, download or registry access.
const external = vi.hoisted(() => ({
	configured: [] as { source: string; scope: "user" | "project"; installedPath?: string }[],
	update: vi.fn(),
	settings: vi.fn(),
	hasScopedUpdate: true,
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	class FakeManager {
		listConfiguredPackages() {
			return external.configured;
		}
		getInstalledPath(source: string, scope: string) {
			return external.configured.find((p) => p.source === source && p.scope === scope)?.installedPath;
		}
	}
	return {
		...actual,
		SettingsManager: { create: external.settings },
		DefaultPackageManager: class extends FakeManager {
			constructor() {
				super();
				if (external.hasScopedUpdate)
					Object.assign(this, { updateConfiguredSources: (entries: unknown) => external.update(entries) });
			}
		},
	};
});

import { PackageAdmin } from "../src/packages/admin";

let root: string;
function installed(name: string, version: string) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
	return dir;
}
const noReload = () => vi.fn().mockResolvedValue({ reloaded: 0, skipped: [] });

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "package-update-"));
	external.configured = [];
	external.hasScopedUpdate = true;
	external.update.mockReset().mockResolvedValue(undefined);
	external.settings.mockReset().mockReturnValue({ drainErrors: () => [], flush: async () => {} });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("PackageAdmin.updatePackage", () => {
	it("updates only the requested source + scope and reports the version change", async () => {
		const dir = installed("demo", "1.0.0");
		external.configured = [
			{ source: "npm:demo", scope: "user", installedPath: dir },
			{ source: "npm:demo", scope: "project", installedPath: join(root, "other") },
		];
		external.update.mockImplementation(async () => installed("demo", "1.1.0"));
		const reloadIdleSessions = noReload();
		const admin = new PackageAdmin({ reloadIdleSessions });
		await expect(admin.updatePackage("npm:demo", "user")).resolves.toEqual({ from: "1.0.0", to: "1.1.0" });
		expect(external.update).toHaveBeenCalledWith([{ source: "npm:demo", scope: "user" }]);
		expect(reloadIdleSessions).toHaveBeenCalledOnce();
	});

	it("reports an unchanged version instead of a fake success", async () => {
		external.configured = [{ source: "npm:demo", scope: "user", installedPath: installed("demo", "2.0.0") }];
		const admin = new PackageAdmin({ reloadIdleSessions: noReload() });
		await expect(admin.updatePackage("npm:demo", "user")).resolves.toEqual({ from: "2.0.0", to: "2.0.0" });
	});

	it("reports sessions that keep the old version because they are running", async () => {
		external.configured = [{ source: "npm:demo", scope: "user", installedPath: installed("demo", "1.0.0") }];
		external.update.mockImplementation(async () => installed("demo", "1.1.0"));
		const reloadIdleSessions = vi.fn().mockResolvedValue({
			reloaded: 1,
			skipped: [
				{ sessionId: "a", reason: "streaming" },
				{ sessionId: "b", reason: "compacting" },
			],
		});
		const admin = new PackageAdmin({ reloadIdleSessions });
		await expect(admin.updatePackage("npm:demo", "user")).resolves.toEqual({
			from: "1.0.0",
			to: "1.1.0",
			deferred: 2,
		});
	});

	it("rejects non-npm, unconfigured and project-without-session updates without touching npm", async () => {
		const reloadIdleSessions = vi.fn();
		const admin = new PackageAdmin({ reloadIdleSessions });
		await expect(admin.updatePackage("git:github.com/a/b", "user")).rejects.toThrow("Only npm packages");
		await expect(admin.updatePackage("npm:demo", "project")).rejects.toThrow("requires a session");
		await expect(admin.updatePackage("npm:demo", "user")).rejects.toThrow("Package not installed");
		expect(external.update).not.toHaveBeenCalled();
		expect(reloadIdleSessions).not.toHaveBeenCalled();
	});

	it("npm failure keeps the ENOENT sentinel and does not reload", async () => {
		external.configured = [{ source: "npm:demo", scope: "user", installedPath: installed("demo", "1.0.0") }];
		external.update.mockRejectedValueOnce(new Error("spawn npm ENOENT"));
		const reloadIdleSessions = vi.fn();
		const admin = new PackageAdmin({ reloadIdleSessions });
		await expect(admin.updatePackage("npm:demo", "user")).rejects.toThrow(NPM_NOT_FOUND_SENTINEL);
		expect(reloadIdleSessions).not.toHaveBeenCalled();
	});

	it("fails clearly if the SDK no longer exposes scoped updates", async () => {
		external.hasScopedUpdate = false;
		external.configured = [{ source: "npm:demo", scope: "user", installedPath: installed("demo", "1.0.0") }];
		const admin = new PackageAdmin({ reloadIdleSessions: vi.fn() });
		await expect(admin.updatePackage("npm:demo", "user")).rejects.toThrow(
			"cannot update a single package scope",
		);
	});
});
