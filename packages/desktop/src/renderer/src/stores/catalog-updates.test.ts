import type { ConfiguredPackageInfo, PackageUpdateInfo } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	checkPackageUpdates: vi.fn(),
	listConfiguredPackages: vi.fn(),
	installPackage: vi.fn(),
	removePackage: vi.fn(),
}));
vi.mock("../environment-api", () => ({ getExecutionApi: () => api }));
vi.mock("./settings", () => ({
	getSettingsStore: () => ({ getState: () => ({ refreshAfterMutation: vi.fn() }) }),
}));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const configured = (installedVersion = "1.0.0"): ConfiguredPackageInfo[] => [
	{ source: "npm:demo", scope: "user", installedVersion },
];
const result = (): PackageUpdateInfo[] => [{ name: "demo", latest: "3.0.0" }];
let store: ReturnType<typeof import("./catalog").getCatalogStore>;
beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	api.listConfiguredPackages.mockResolvedValue(configured());
	api.checkPackageUpdates.mockResolvedValue(result());
	store = (await import("./catalog")).getCatalogStore();
});
afterEach(() => vi.useRealTimers());

describe("package update checks", () => {
	it("does not discard a pending local read when installation fails", async () => {
		const local = deferred<ConfiguredPackageInfo[]>();
		api.listConfiguredPackages.mockReturnValueOnce(local.promise);
		const pending = store.getState().refreshConfiguredPackages();
		api.installPackage.mockRejectedValueOnce(new Error("disk failure"));
		await store.getState().installCatalogPackage("demo");
		local.resolve(configured());
		await pending;
		expect(store.getState().configuredPackages?.[0]?.installedVersion).toBe("1.0.0");
	});
	it("publishes current local versions without waiting for or copying them from the registry", async () => {
		await store.getState().refreshConfiguredPackages();
		const network = deferred<PackageUpdateInfo[]>();
		api.checkPackageUpdates.mockReturnValue(network.promise);
		const pending = store.getState().checkUpdates();
		api.listConfiguredPackages.mockResolvedValue(configured("2.0.0"));
		await store.getState().refreshConfiguredPackages();
		expect(store.getState().configuredPackages?.[0]?.installedVersion).toBe("2.0.0");
		network.resolve(result());
		await pending;
		expect(store.getState().configuredPackages?.[0]?.installedVersion).toBe("2.0.0");
		expect(store.getState().packageUpdates.demo?.latest).toBe("3.0.0");
	});

	it("shares in-flight checks and caches successful versions for five minutes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
		await store.getState().refreshConfiguredPackages();
		const network = deferred<PackageUpdateInfo[]>();
		api.checkPackageUpdates.mockReturnValueOnce(network.promise);
		const first = store.getState().checkUpdates();
		const second = store.getState().checkUpdates();
		await Promise.resolve();
		expect(api.checkPackageUpdates).toHaveBeenCalledOnce();
		network.resolve(result());
		await Promise.all([first, second]);
		await store.getState().checkUpdates();
		expect(api.checkPackageUpdates).toHaveBeenCalledOnce();
		vi.setSystemTime(new Date("2026-11-01T00:05:01Z"));
		await store.getState().checkUpdates();
		expect(api.checkPackageUpdates).toHaveBeenCalledTimes(2);
	});

	it.each(["install", "remove"])("preserves valid hints when %s fails", async (kind) => {
		await store.getState().refreshConfiguredPackages();
		await store.getState().checkUpdates();
		const previous = store.getState().packageUpdates;
		api.installPackage.mockRejectedValueOnce(new Error("disk failure"));
		api.removePackage.mockRejectedValueOnce(new Error("disk failure"));
		if (kind === "install") await store.getState().installCatalogPackage("demo");
		else await store.getState().removeConfiguredPackage("npm:demo", "user");
		expect(store.getState().packageUpdates).toBe(previous);
		expect(store.getState().configuredPackages?.[0]?.installedVersion).toBe("1.0.0");
	});

	it("refreshes unchanged local records without discarding npm cache", async () => {
		await store.getState().refreshConfiguredPackages();
		await store.getState().checkUpdates();
		const previous = store.getState().packageUpdates;
		await store.getState().refreshConfiguredPackages();
		await store.getState().checkUpdates();
		expect(store.getState().packageUpdates).toBe(previous);
		expect(api.checkPackageUpdates).toHaveBeenCalledOnce();
	});

	it("rejects late local reads after a project switch and does not restore another project's data on failure", async () => {
		const old = deferred<ConfiguredPackageInfo[]>();
		api.listConfiguredPackages.mockReturnValueOnce(old.promise).mockResolvedValue(configured("2.0.0"));
		const first = store.getState().refreshConfiguredPackages("a");
		await store.getState().refreshConfiguredPackages("b");
		old.resolve(configured());
		await first;
		expect(store.getState().configuredSessionId).toBe("b");
		expect(store.getState().configuredPackages?.[0]?.installedVersion).toBe("2.0.0");
		api.listConfiguredPackages.mockRejectedValueOnce(new Error("disconnected"));
		await store.getState().refreshConfiguredPackages("c");
		expect(store.getState().configuredPackages).toBeNull();
		expect(api.listConfiguredPackages).toHaveBeenLastCalledWith({ sessionId: "c" });
	});

	it("checks newly installed packages after the current registry request completes", async () => {
		await store.getState().refreshConfiguredPackages();
		const old = deferred<PackageUpdateInfo[]>();
		api.checkPackageUpdates
			.mockReturnValueOnce(old.promise)
			.mockResolvedValueOnce([{ name: "other", latest: "4.0.0" }]);
		const first = store.getState().checkUpdates();
		await Promise.resolve();
		api.listConfiguredPackages.mockResolvedValue([...configured(), { source: "npm:other", scope: "user" }]);
		await store.getState().refreshConfiguredPackages();
		const second = store.getState().checkUpdates();
		old.resolve(result());
		await Promise.all([first, second]);
		expect(api.checkPackageUpdates.mock.calls).toEqual([[{ names: ["demo"] }], [{ names: ["other"] }]]);
		expect(store.getState().packageUpdates.other?.latest).toBe("4.0.0");
	});

	it("retries only failed package names, keeping successful results", async () => {
		api.listConfiguredPackages.mockResolvedValue([
			...configured(),
			{ source: "npm:other", scope: "project" },
		]);
		await store.getState().refreshConfiguredPackages();
		api.checkPackageUpdates
			.mockResolvedValueOnce([...result(), { name: "other", latest: "" }])
			.mockResolvedValueOnce([{ name: "other", latest: "4.0.0" }]);
		await store.getState().checkUpdates();
		await store.getState().checkUpdates();
		await store.getState().checkUpdates();
		expect(api.checkPackageUpdates.mock.calls).toEqual([
			[{ names: ["demo", "other"] }],
			[{ names: ["other"] }],
		]);
		expect(store.getState().packageUpdates.demo?.latest).toBe("3.0.0");
	});

	it("keeps the removal target captured while another project becomes active", async () => {
		await store.getState().refreshConfiguredPackages("a");
		const mutation = deferred<void>();
		api.removePackage.mockReturnValue(mutation.promise);
		const pending = store.getState().removeConfiguredPackage("npm:demo", "project");
		await store.getState().refreshConfiguredPackages("b");
		mutation.resolve();
		await pending;
		expect(api.removePackage).toHaveBeenCalledWith({ source: "npm:demo", scope: "project", sessionId: "a" });
		expect(store.getState().configuredSessionId).toBe("b");
		expect(api.listConfiguredPackages).toHaveBeenLastCalledWith({ sessionId: "b" });
	});
});
