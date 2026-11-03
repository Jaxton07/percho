// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pi = vi.hoisted(() => ({
	platform: "win32",
	openPath: vi.fn(() => Promise.resolve()),
	revealPath: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../api", () => ({ getPi: () => pi }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

import { useToastsStore } from "../../stores/toasts";
import { FilePathMenu, revealCopy } from "./FilePathMenu";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	useToastsStore.setState({ toasts: [] });
	pi.revealPath.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

async function mount(platform: string) {
	pi.platform = platform;
	await act(async () =>
		root.render(
			<FilePathMenu
				target="src/a.ts"
				cwd={null}
				anchor={{ left: 10, top: 10, width: 0, height: 0 }}
				onClose={() => {}}
			/>,
		),
	);
	return [...document.querySelectorAll("[role=menuitem]")].map((item) => item.textContent?.trim());
}

describe("FilePathMenu reveal copy", () => {
	it.each([
		["darwin", "pathMenu.reveal", "toast.pathRevealFailed"],
		["win32", "pathMenu.revealExplorer", "toast.pathRevealFailedExplorer"],
		["linux", "pathMenu.revealFolder", "toast.pathRevealFailedFolder"],
	])("%s uses its own file manager wording", (platform, label, failed) => {
		expect(revealCopy(platform)).toEqual({ label, failed });
	});

	it("shows the platform label in the menu and reports reveal failures with the same wording", async () => {
		expect(await mount("win32")).toContain("pathMenu.revealExplorer");
		pi.revealPath.mockRejectedValueOnce(new Error("Path not found"));
		const reveal = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
			(item) => item.textContent?.trim() === "pathMenu.revealExplorer",
		);
		await act(async () => reveal?.click());
		expect(useToastsStore.getState().toasts.map((toast) => toast.titleKey)).toEqual([
			"toast.pathRevealFailedExplorer",
		]);
	});
});
