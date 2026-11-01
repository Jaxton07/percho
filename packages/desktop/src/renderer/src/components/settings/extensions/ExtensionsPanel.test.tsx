// @vitest-environment happy-dom
import type { ConfiguredPackageInfo, LoadedExtension, PackageUpdateInfo } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	activeSessionId: "a",
	api: { listConfiguredPackages: vi.fn(), checkPackageUpdates: vi.fn(), removePackage: vi.fn() },
	extensions: [
		{
			name: "demo",
			path: "/project/demo/index.ts",
			source: "npm:demo",
			scope: "project",
			hidden: false,
			toolsCount: 0,
			tools: [],
			commands: [],
			flagsCount: 0,
			shortcutsCount: 0,
		},
	] as LoadedExtension[],
}));
vi.mock("../../../environment-api", () => ({ getExecutionApi: () => fixture.api }));
vi.mock("../../../stores/settings", () => ({
	useSettingsStore: (select: (s: { extensions: LoadedExtension[]; extensionErrors: [] }) => unknown) =>
		select({ extensions: fixture.extensions, extensionErrors: [] }),
	getSettingsStore: () => ({ getState: () => ({ refreshAfterMutation: vi.fn() }) }),
}));
vi.mock("../../../stores/sessions", () => ({
	useSessionsStore: (select: (s: { activeSessionId: string }) => unknown) =>
		select({ activeSessionId: fixture.activeSessionId }),
}));
vi.mock("../../../i18n", () => ({
	useT: () => (key: string, args?: { version?: string }) => `${key} ${args?.version ?? ""}`,
}));
vi.mock("./BrowseSection", () => ({ BrowseSection: () => null }));

import { getCatalogStore } from "../../../stores/catalog";
import { ExtensionsPanel } from "./ExtensionsPanel";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const configured = (installedVersion: string): ConfiguredPackageInfo[] => [
	{ source: "npm:demo", scope: "project", installedVersion },
];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	fixture.activeSessionId = "a";
	fixture.api.listConfiguredPackages.mockResolvedValue(configured("1.0.0"));
	fixture.api.checkPackageUpdates.mockResolvedValue([{ name: "demo", latest: "3.0.0" }]);
	getCatalogStore().setState({
		extensionsTab: "loaded",
		configuredPackages: null,
		configuredSessionId: null,
		packageUpdates: {},
		removingSources: {},
		removeErrors: {},
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

it("loads local versions before network hints and retains the hint after a failed uninstall", async () => {
	const network = deferred<PackageUpdateInfo[]>();
	fixture.api.checkPackageUpdates.mockReturnValue(network.promise);
	await act(async () => root.render(<ExtensionsPanel />));
	expect(host.textContent).toContain("settings.extensions.version 1.0.0");
	expect(host.textContent).not.toContain("settings.extensions.updateAvailable");
	expect(fixture.api.listConfiguredPackages).toHaveBeenCalledWith({ sessionId: "a" });
	await act(async () => {
		network.resolve([{ name: "demo", latest: "2.0.0" }]);
	});
	expect(host.textContent).toContain("settings.extensions.updateAvailable 2.0.0");
	fixture.api.removePackage.mockRejectedValueOnce(new Error("disk failure"));
	const uninstall = host.querySelector('button[aria-label^="settings.extensions.uninstall"]');
	expect(uninstall).not.toBeNull();
	await act(() => {
		uninstall?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	const confirm = [...host.querySelectorAll("button")].find((b) =>
		b.textContent?.includes("settings.extensions.confirmUninstall"),
	);
	expect(confirm).toBeDefined();
	await act(async () => {
		confirm?.click();
	});
	expect(fixture.api.removePackage).toHaveBeenCalledWith({
		source: "npm:demo",
		scope: "project",
		sessionId: "a",
	});
	expect(host.textContent).toContain("settings.extensions.updateAvailable 2.0.0");
	expect(fixture.api.checkPackageUpdates).toHaveBeenCalledOnce();
	fixture.api.removePackage.mockResolvedValueOnce(undefined);
	fixture.api.listConfiguredPackages.mockResolvedValueOnce([]);
	await act(async () => {
		await getCatalogStore().getState().removeConfiguredPackage("npm:demo", "project");
	});
	expect(host.textContent).not.toContain("settings.extensions.updateAvailable");
	expect(fixture.api.checkPackageUpdates).toHaveBeenCalledOnce();
});

it("rejects a delayed project's local response after the active session changes", async () => {
	const first = deferred<ConfiguredPackageInfo[]>();
	fixture.api.listConfiguredPackages.mockImplementation(({ sessionId }: { sessionId?: string }) =>
		sessionId === "a" ? first.promise : Promise.resolve(configured("2.0.0")),
	);
	await act(async () => root.render(<ExtensionsPanel />));
	fixture.activeSessionId = "b";
	await act(async () => root.render(<ExtensionsPanel />));
	expect(host.textContent).toContain("settings.extensions.version 2.0.0");
	await act(async () => {
		first.resolve(configured("1.0.0"));
	});
	expect(host.textContent).toContain("settings.extensions.version 2.0.0");
	expect(host.textContent).not.toContain("settings.extensions.version 1.0.0");
	expect(getCatalogStore().getState().configuredSessionId).toBe("b");
});
