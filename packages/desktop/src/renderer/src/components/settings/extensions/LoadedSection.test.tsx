import type { ConfiguredPackageInfo, LoadedExtension } from "@percho/shared";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	extensions: [] as LoadedExtension[],
	extensionErrors: [],
	configuredPackages: [] as ConfiguredPackageInfo[],
	configuredSessionId: null,
	packageUpdates: {} as Record<string, { latest: string; checkedAt: number }>,
	removingSources: {},
	updatingSources: {},
	updateResults: {} as Record<string, unknown>,
	updatePackages: vi.fn(),
	updateConfiguredPackage: vi.fn(),
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
	state.packageUpdates = {};
	state.updateResults = {};
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

it("compares the cached npm version against each scope's own installed version", () => {
	state.packageUpdates = {
		demo: { latest: "2.0.0", checkedAt: Date.now() },
	};
	const html = renderToStaticMarkup(React.createElement(LoadedSection));
	const rows = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g);
	expect(rows?.[0]).toContain("settings.extensions.updateAvailable 2.0.0");
	expect(rows?.[1]).not.toContain("settings.extensions.updateAvailable");
});

it("offers Update only where a newer version exists and the source is not pinned", () => {
	const template = state.extensions[0] as LoadedExtension;
	state.configuredPackages = [
		{ source: "npm:demo", scope: "user", installedVersion: "1.0.0" },
		{ source: "npm:pinned@1.0.0", scope: "user", installedVersion: "1.0.0" },
		{ source: "npm:fresh", scope: "user", installedVersion: "2.0.0" },
	];
	state.extensions = state.configuredPackages.map((p, i) => ({
		...template,
		name: `ext${i}`,
		source: p.source,
		scope: p.scope,
		path: `/user/${i}/index.ts`,
	}));
	state.packageUpdates = {
		demo: { latest: "2.0.0", checkedAt: Date.now() },
		pinned: { latest: "2.0.0", checkedAt: Date.now() },
		fresh: { latest: "2.0.0", checkedAt: Date.now() },
	};
	const html = renderToStaticMarkup(React.createElement(LoadedSection));
	const rows = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [];
	expect(rows[0]).toMatch(/<button[^>]*>settings\.extensions\.update <\/button>/);
	expect(rows[1]).toContain("settings.extensions.updateAvailable 2.0.0");
	expect(rows[1]).not.toMatch(/<button[^>]*>settings\.extensions\.update <\/button>/);
	expect(rows[2]).not.toContain("settings.extensions.updateAvailable");
	// 只有一个可更新时不显示「全部更新」
	expect(html).not.toContain("settings.extensions.updateAll");
});

it("shows Update all when more than one package can be updated, and per-row outcomes", () => {
	state.packageUpdates = { demo: { latest: "3.0.0", checkedAt: Date.now() } };
	state.updateResults = { "npm:demo": { kind: "error", message: "network down" } };
	const html = renderToStaticMarkup(React.createElement(LoadedSection));
	expect(html).toContain("settings.extensions.updateAll");
	expect(html).toContain("settings.extensions.updateFailed");
});
