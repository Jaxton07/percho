import type { ConfiguredPackageInfo, LoadedExtension, PackageUpdateInfo } from "@percho/shared";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	extensions: [] as LoadedExtension[],
	extensionErrors: [],
	configuredPackages: [] as ConfiguredPackageInfo[],
	packageUpdates: null as Record<string, PackageUpdateInfo> | null,
	checkUpdates: vi.fn(),
	refreshConfiguredPackages: vi.fn(),
	removingSources: {},
}));
vi.mock("../../../stores/catalog", () => ({
	useCatalogStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock("../../../stores/settings", () => ({
	useSettingsStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock("../../../i18n", () => ({
	useT: () => (key: string, args?: { version?: string }) => `${key} ${args?.version ?? ""}`,
}));

import { LoadedSection } from "./LoadedSection";

beforeEach(() => {
	vi.stubGlobal("React", React);
	state.packageUpdates = null;
	state.configuredPackages = [
		{ source: "npm:demo", scope: "user", installedVersion: "1.0.0" },
		{ source: "npm:demo", scope: "project", installedVersion: "2.0.0" },
	];
	state.extensions = state.configuredPackages.map((p) => ({
		name: p.scope,
		source: p.source,
		scope: p.scope,
		path: `/${p.scope}/demo/index.ts`,
		hidden: false,
		toolsCount: 0,
		tools: [],
		commands: [],
		flagsCount: 0,
		shortcutsCount: 0,
	}));
});
afterEach(() => vi.unstubAllGlobals());

it("renders both local versions before registry results exist", () => {
	const html = renderToStaticMarkup(React.createElement(LoadedSection));
	expect(html).toContain("settings.extensions.version 1.0.0");
	expect(html).toContain("settings.extensions.version 2.0.0");
	expect(html).not.toContain("settings.extensions.updateAvailable");
});

it("matches the update hint to the installation scope", () => {
	state.packageUpdates = {
		"user:npm:demo": {
			name: "demo",
			source: "npm:demo",
			scope: "user",
			installed: "1.0.0",
			latest: "3.0.0",
			hasUpdate: true,
		},
	};
	const html = renderToStaticMarkup(React.createElement(LoadedSection));
	const rows = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g);
	expect(rows?.[0]).toContain("settings.extensions.updateAvailable 3.0.0");
	expect(rows?.[1]).not.toContain("settings.extensions.updateAvailable");
});
