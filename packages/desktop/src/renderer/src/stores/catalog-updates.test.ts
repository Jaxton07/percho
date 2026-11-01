import { type ConfiguredPackageInfo, configuredPackageKey, type PackageUpdateInfo } from "@percho/shared";
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
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const configured = (installedVersion = "1.0.0"): ConfiguredPackageInfo[] => [
	{ source: "npm:demo", scope: "user", installedVersion },
];
const result = (installed = "1.0.0"): PackageUpdateInfo[] => [
	{ name: "demo", source: "npm:demo", scope: "user", installed, latest: "3.0.0", hasUpdate: true },
];
let store: ReturnType<typeof import("./catalog").getCatalogStore>;
const key = configuredPackageKey({ source: "npm:demo", scope: "user" });
beforeEach(async () => {
	vi.resetModules();
	vi.resetAllMocks();
	api.listConfiguredPackages.mockResolvedValue(configured());
	api.checkPackageUpdates.mockResolvedValue(result());
	store = (await import("./catalog")).getCatalogStore();
});
afterEach(() => vi.useRealTimers());

describe("package update checks", () => {
	it("publishes local versions while network requests are still pending", async () => {
		const network = deferred<PackageUpdateInfo[]>();
		api.checkPackageUpdates.mockReturnValue(network.promise);
		const pending = store.getState().checkUpdates();
		await store.getState().refreshConfiguredPackages();
		expect(store.getState().configuredPackages?.[0]?.installedVersion).toBe("1.0.0");
		expect(store.getState().packageUpdates).toBeNull();
		network.resolve(result());
		await pending;
	});

	it("shares in-flight checks and reuses successful results for five minutes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
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

	it("does not discard the network cache when local records are unchanged", async () => {
		await store.getState().refreshConfiguredPackages();
		const previous = store.getState().configuredPackages;
		await store.getState().checkUpdates();
		await store.getState().refreshConfiguredPackages();
		await store.getState().checkUpdates();
		expect(store.getState().configuredPackages).toBe(previous);
		expect(api.checkPackageUpdates).toHaveBeenCalledOnce();
	});

	it("rejects a late local read and preserves trusted versions after a read failure", async () => {
		const old = deferred<ConfiguredPackageInfo[]>();
		api.listConfiguredPackages.mockReturnValueOnce(old.promise).mockResolvedValue(configured("2.0.0"));
		const first = store.getState().refreshConfiguredPackages();
		await store.getState().refreshConfiguredPackages();
		old.resolve(configured());
		await first;
		expect(store.getState().configuredPackages?.[0]?.installedVersion).toBe("2.0.0");
		api.listConfiguredPackages.mockRejectedValueOnce(new Error("disconnected"));
		await store.getState().refreshConfiguredPackages();
		expect(store.getState().configuredPackages?.[0]?.installedVersion).toBe("2.0.0");
	});

	it("rejects an old response after local records change, without clearing the newer request's busy state", async () => {
		await store.getState().refreshConfiguredPackages();
		const old = deferred<PackageUpdateInfo[]>();
		const current = deferred<PackageUpdateInfo[]>();
		api.checkPackageUpdates.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
		const first = store.getState().checkUpdates();
		await Promise.resolve();
		api.listConfiguredPackages.mockResolvedValue(configured("2.0.0"));
		await store.getState().refreshConfiguredPackages();
		const second = store.getState().checkUpdates();
		old.resolve(result());
		await first;
		expect(store.getState().checkingUpdates).toBe(true);
		expect(store.getState().packageUpdates).toBeNull();
		current.resolve(result("2.0.0"));
		await second;
		expect(store.getState().packageUpdates?.[key]?.installed).toBe("2.0.0");
		expect(store.getState().checkingUpdates).toBe(false);
	});

	it.each(["install", "remove"])(
		"invalidates requests across %s even if the final local records are unchanged",
		async (kind) => {
			await store.getState().refreshConfiguredPackages();
			const old = deferred<PackageUpdateInfo[]>();
			api.checkPackageUpdates.mockReturnValueOnce(old.promise).mockResolvedValue(result("2.0.0"));
			const pending = store.getState().checkUpdates();
			await Promise.resolve();
			if (kind === "install") await store.getState().installCatalogPackage("demo");
			else await store.getState().removeConfiguredPackage("npm:demo", "user");
			await store.getState().checkUpdates();
			old.resolve(result());
			await pending;
			expect(store.getState().packageUpdates?.[key]?.installed).toBe("2.0.0");
		},
	);

	it("retries a failed request or incomplete registry result and preserves local versions", async () => {
		await store.getState().refreshConfiguredPackages();
		api.checkPackageUpdates
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce([{ ...result()[0], latest: "" }])
			.mockResolvedValueOnce(result());
		await store.getState().checkUpdates();
		expect(store.getState().checkingUpdates).toBe(false);
		await store.getState().checkUpdates();
		await store.getState().checkUpdates();
		expect(api.checkPackageUpdates).toHaveBeenCalledTimes(3);
		expect(store.getState().configuredPackages?.[0]?.installedVersion).toBe("1.0.0");
	});

	it("keeps same-source records in different scopes separate", async () => {
		const user = result()[0];
		api.checkPackageUpdates.mockResolvedValue([user, { ...user, scope: "project", installed: "2.0.0" }]);
		await store.getState().checkUpdates();
		expect(store.getState().packageUpdates?.[key]?.installed).toBe("1.0.0");
		expect(store.getState().packageUpdates?.["project:npm:demo"]?.installed).toBe("2.0.0");
	});
});
