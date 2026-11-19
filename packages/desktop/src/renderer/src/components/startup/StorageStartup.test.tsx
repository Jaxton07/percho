// @vitest-environment happy-dom
import type { StorageStartupAction, StorageStartupState } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const state: StorageStartupState = {
	phase: "choice",
	source: "/old",
	target: "/new",
	files: 0,
	bytes: 0,
	external: [],
};
it("scans before review and confirms copying, with separate warning details", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	const { useI18nStore } = await import("../../i18n");
	const { StorageStartup } = await import("./StorageStartup");
	useI18nStore.setState({ language: "en" });
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const actions: StorageStartupAction[] = [];
	const render = async (value: StorageStartupState) =>
		act(() =>
			root.render(<StorageStartup state={value} error="" onAction={(action) => actions.push(action)} />),
		);
	const click = async (label: string) => {
		const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
		expect(button, label).toBeDefined();
		await act(() => button?.click());
	};
	await render(state);
	await click("Continue");
	expect(actions).toEqual(["scan"]);
	await render({
		...state,
		phase: "review",
		warnings: [{ path: "skills/missing", reason: "missing-link-target" }],
		external: ["/shared"],
	});
	await click("1 broken resource");
	expect(document.body.textContent).toContain("skills/missing");
	expect(document.body.textContent).toContain("Link target does not exist");
	await click("Done");
	await click("1 external resources");
	expect(document.body.textContent).toContain("/shared");
	expect(document.body.textContent).not.toContain("skills/missing");
	await click("Done");
	await click("Start transfer");
	expect(actions).toEqual(["scan", "copy"]);
	await act(() => root.unmount());
	node.remove();
});
it("shows copy recovery details, returns to fresh-start confirmation and hides unsafe retry", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
	const { useI18nStore } = await import("../../i18n");
	const { StorageStartup } = await import("./StorageStartup");
	useI18nStore.setState({ language: "en" });
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const actions: StorageStartupAction[] = [];
	const render = async (value: StorageStartupState) =>
		act(() =>
			root.render(<StorageStartup state={value} error="" onAction={(action) => actions.push(action)} />),
		);
	const click = async (label: string) => {
		const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
		expect(button, label).toBeDefined();
		await act(() => button?.click());
	};
	await render({
		...state,
		phase: "error",
		canReturn: true,
		retryable: true,
		recoveryPath: "/new/.agent-import-fixture",
		error: "copy failed",
	});
	await click("Error details");
	expect(document.body.textContent).toContain("Recovery copy location");
	expect(document.body.textContent).toContain("/new/.agent-import-fixture");
	await click("Done");
	await click("Back");
	expect(actions).toEqual(["back"]);
	await render(state);
	const radio = node.querySelector<HTMLInputElement>('input[value="empty"]');
	await act(() => radio?.click());
	await click("Continue");
	expect(actions).toEqual(["back"]);
	await click("Start fresh");
	expect(actions).toEqual(["back", "empty"]);
	await render({ ...state, phase: "error", retryable: false, canReturn: false });
	expect(node.textContent).not.toContain("Retry");
	expect(node.textContent).not.toContain("Back");
	await act(() => root.unmount());
	node.remove();
});
afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
