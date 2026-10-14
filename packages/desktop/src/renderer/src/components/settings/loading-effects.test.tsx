import React, { type EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Execute the actual panel effect callbacks in Node. Hook registration/scheduling is controlled;
// this is not an Electron DOM/visual test or a claim about StrictMode render counts.
const harness = vi.hoisted(() => ({
	effects: [] as Array<{ callback: EffectCallback; deps: unknown[] | undefined }>,
	tab: "providers",
	state: {
		providers: [],
		loading: false,
		refreshing: false,
		error: null,
		lanStatus: null as null | { enabled: boolean; urls: string[] },
		lanSaving: false,
		refreshProvidersFromNetwork: vi.fn().mockResolvedValue(undefined),
		refreshLanStatus: vi.fn().mockResolvedValue(undefined),
		setLanEnabled: vi.fn(),
		setLanRemoteControl: vi.fn(),
		permissionGateOff: null,
		loadPermissionGate: vi.fn().mockResolvedValue(undefined),
	},
}));
vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	return {
		...actual,
		useEffect: (callback: EffectCallback, deps?: unknown[]) => {
			harness.effects.push({ callback, deps });
		},
		useState: (value: unknown) => [typeof value === "string" ? harness.tab : value, vi.fn()],
		useRef: () => ({ current: null }),
	};
});
vi.mock("../../stores/settings", () => ({
	useSettingsStore: Object.assign(
		(selector: (state: typeof harness.state) => unknown) => selector(harness.state),
		{ getState: () => harness.state },
	),
}));
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: (selector: (state: any) => unknown) =>
		selector({
			activeSessionId: null,
			newSessionDraft: { permissionMode: "default" },
			permissionModes: {},
			setDraftPermissionMode: vi.fn(),
			setSessionPermissionMode: vi.fn(),
		}),
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("./providers/CustomProviderForm", () => ({ CustomProviderForm: () => null }));
vi.mock("./providers/LoginDialog", () => ({ LoginDialog: () => null }));
vi.mock("./providers/ProviderRow", () => ({ IconAction: () => null, ProviderRow: () => null }));
vi.mock("./providers/SubagentPanel", () => ({ SubagentPanel: () => null }));

import { PermissionPicker } from "../composer/PermissionPicker";
import { LanObserverPanel } from "./LanObserverPanel";
import { ProvidersPanel } from "./providers/ProvidersPanel";

beforeEach(() => {
	vi.stubGlobal("React", React);
	vi.useFakeTimers();
	vi.clearAllMocks();
	harness.effects = [];
	harness.tab = "providers";
	harness.state.lanStatus = null;
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("V03 panel effect callback ownership", () => {
	it("providers effect is mount-scoped, independent of sub-tab state, and refreshes only network catalog", () => {
		ProvidersPanel();
		expect(harness.effects).toHaveLength(1);
		expect(harness.effects[0]?.deps).toEqual([]);
		harness.effects[0]?.callback();
		expect(harness.state.refreshProvidersFromNetwork).toHaveBeenCalledTimes(1);
		expect(harness.state.refreshLanStatus).not.toHaveBeenCalled();
		harness.effects = [];
		harness.tab = "subagents";
		ProvidersPanel();
		expect(harness.effects[0]?.deps).toEqual([]); // React keeps the same [] effect on sub-tab rerender.
	});
	it("permission picker bootstraps the gate independently of opening settings", () => {
		PermissionPicker();
		expect(harness.effects).toHaveLength(2);
		expect(harness.effects[0]?.deps).toEqual([harness.state.loadPermissionGate]);
		harness.effects[0]?.callback();
		expect(harness.state.loadPermissionGate).toHaveBeenCalledOnce();
		expect(harness.state.refreshProvidersFromNetwork).not.toHaveBeenCalled();
		expect(harness.state.refreshLanStatus).not.toHaveBeenCalled();
	});
	it("LAN has no initial load callback; enabled-only polling retains 5s and cleanup", () => {
		LanObserverPanel();
		expect(harness.effects).toHaveLength(1);
		harness.effects[0]?.callback();
		vi.advanceTimersByTime(10000);
		expect(harness.state.refreshLanStatus).not.toHaveBeenCalled();
		expect(harness.state.refreshProvidersFromNetwork).not.toHaveBeenCalled();
		harness.effects = [];
		harness.state.lanStatus = { enabled: true, urls: [] };
		LanObserverPanel();
		const cleanup = harness.effects[0]?.callback();
		vi.advanceTimersByTime(5000);
		expect(harness.state.refreshLanStatus).toHaveBeenCalledTimes(1);
		if (typeof cleanup !== "function") throw Error("Expected enabled polling cleanup");
		cleanup();
		vi.advanceTimersByTime(10000);
		expect(harness.state.refreshLanStatus).toHaveBeenCalledTimes(1);
	});
});
