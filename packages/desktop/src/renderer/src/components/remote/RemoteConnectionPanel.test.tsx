// @vitest-environment happy-dom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, assert, expect, it, vi } from "vitest";

const discover = vi.fn(async () => ({ aliases: ["new-host"], incomplete: false }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../api", () => ({ getPi: () => ({ remoteListSshAliases: discover }) }));

import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { RemoteConnectionPanel } from "./RemoteConnectionDialog";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
	vi.clearAllMocks();
});

async function mount(connected = false) {
	const capture = vi.fn((connectionId = "a") => ({ epoch: "run", generation: 1, connectionId }));
	const switchConnection = vi.fn(async () => {});
	const forget = vi.fn(async () => {});
	const connect = vi.fn(async () => {});
	useRemoteConnectionStore.setState({
		open: false,
		targetEnvironment: null,
		lastChecks: {},
		status: {
			epoch: "run",
			generation: 1,
			revision: 1,
			state: connected ? "connected" : "disconnected",
			connectionId: connected ? "a" : undefined,
		},
		catalog: {
			epoch: "run",
			revision: 1,
			records: [
				{ connectionId: "a", alias: "first", revision: 3 },
				{ connectionId: "b", alias: "second", revision: 4 },
			],
			lastSuccessfulConnectionId: null,
		},
		capture,
		switchConnection,
		forget,
		connect,
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<RemoteConnectionPanel />));
	cleanup = async () => {
		await act(async () => root.unmount());
		container.remove();
	};
	return { capture, switchConnection, forget, connect };
}
async function click(element: Element | null) {
	expect(element).not.toBeNull();
	await act(async () => {
		(element as HTMLElement).click();
	});
}
function button(text: string) {
	return [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === text) ?? null;
}

it("keeps the parent settings open when Escape closes the portal menu", async () => {
	await mount();
	const panel = document.querySelector(".remote-panel") as HTMLElement;
	const settings = panel.parentElement as HTMLElement;
	settings.setAttribute("role", "dialog");
	const closeSettings = vi.fn();
	const key = (event: KeyboardEvent) => {
		if (event.key === "Escape" && !event.defaultPrevented) closeSettings();
	};
	document.addEventListener("keydown", key);
	try {
		const trigger = document.querySelector<HTMLElement>('[aria-label="remote.ux.more first"]');
		trigger?.focus();
		await click(trigger ?? null);
		const menu = document.querySelector('[role="menu"]');
		expect(menu).not.toBeNull();
		expect(settings.contains(menu)).toBe(false);
		expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
		await act(async () =>
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
			),
		);
		expect(document.activeElement?.textContent).toBe("remote.connect");
		await act(async () =>
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
			),
		);
		expect(document.activeElement?.textContent).toBe("remote.forget");
		await act(async () =>
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			),
		);
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(closeSettings).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(trigger);
	} finally {
		document.removeEventListener("keydown", key);
	}
});

it("focuses the first menu item only after the popup becomes visible", async () => {
	const originalFocus = HTMLElement.prototype.focus;
	const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
		this: HTMLElement,
		options,
	) {
		if (this.closest<HTMLElement>('[role="menu"]')?.style.visibility === "hidden") return;
		originalFocus.call(this, options);
	});
	try {
		await mount();
		await click(document.querySelector('[aria-label="remote.ux.more second"]'));
		expect(document.activeElement).toBe(document.querySelector('[role="menuitem"]'));
	} finally {
		focus.mockRestore();
	}
});

it("shows only the selected record's fresh or cached diagnostics", async () => {
	await mount();
	await act(async () =>
		useRemoteConnectionStore.setState({
			catalog: {
				epoch: "run",
				revision: 2,
				lastSuccessfulConnectionId: null,
				records: [
					{
						connectionId: "a",
						alias: "first",
						revision: 1,
						binding: {
							environmentId: "env-a",
							uid: 42,
							canonicalAgentDir: "/cached/a",
							node: "/cached/node",
							releaseId: "old-a",
							target: { hostname: "a.host", user: "alice", port: "22" },
						},
					},
					{ connectionId: "b", alias: "second", revision: 1 },
				],
			},
			status: {
				epoch: "run",
				generation: 2,
				revision: 2,
				state: "disconnected",
				connectionId: "b",
				preflight: {
					alias: "second",
					target: { hostname: "fresh.host", user: "bob", port: "2222" },
					uid: 99,
					home: "/home/b",
					node: "/fresh/node",
					nodeVersion: "v22",
					platform: "linux",
					arch: "arm64",
					glibc: "2",
					commands: {},
					installed: true,
					installedReleaseId: "fresh-release",
					agentDir: "/fresh/b",
				},
			},
		}),
	);
	await click(document.querySelector('[aria-label="remote.ux.more second"]'));
	await click(button("remote.ux.details"));
	expect(document.body.textContent).toContain("bob@fresh.host:2222");
	expect(document.body.textContent).toContain("fresh-release");
	const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
	await click(button("remote.ux.copyDiagnostics"));
	expect(writeText).toHaveBeenCalledWith(expect.stringContaining("fresh.host"));
	expect(writeText.mock.calls[0]?.[0]).not.toContain("token");
	writeText.mockRestore();
	await click(button("common.cancel"));
	await click(document.querySelector('[aria-label="remote.ux.more first"]'));
	await click(button("remote.ux.details"));
	expect(document.body.textContent).toContain("/cached/node");
	expect(document.body.textContent).toContain("/cached/a");
	expect(document.body.textContent).toContain("42");
	expect(document.body.textContent).not.toContain("fresh.host");
	expect(document.body.textContent).not.toContain("fresh-release");
	await click(button("common.cancel"));
	const originalPreflight = useRemoteConnectionStore.getState().status.preflight;
	assert(originalPreflight);
	const checkA = {
		...originalPreflight,
		alias: "first",
		environmentId: "env-a",
		uid: 42,
		target: { hostname: "a.host", user: "alice", port: "22" },
		agentDir: "/cached/a",
		node: "/upgraded/a/node",
		installedReleaseId: "new-a",
	};
	await act(async () => {
		useRemoteConnectionStore.getState().accept({
			epoch: "run",
			generation: 3,
			revision: 3,
			state: "disconnected",
			connectionId: "a",
			preflight: checkA,
		});
		useRemoteConnectionStore
			.getState()
			.accept({ epoch: "run", generation: 4, revision: 4, state: "disconnected", connectionId: "b" });
	});
	await click(document.querySelector('[aria-label="remote.ux.more first"]'));
	await click(button("remote.ux.details"));
	expect(document.body.textContent).toContain("/upgraded/a/node");
	expect(document.body.textContent).toContain("new-a");
	expect(document.body.textContent).not.toContain("fresh.host");
});

it("discovers hosts without connecting when the user selects a candidate", async () => {
	const { connect } = await mount();
	await click(button("remote.ux.add"));
	expect(discover).toHaveBeenCalled();
	const radio = document.querySelector<HTMLInputElement>('input[value="new-host"]');
	await click(radio);
	expect(connect).not.toHaveBeenCalled();
	expect((button("remote.ux.addConnect") as HTMLButtonElement).disabled).toBe(false);
	await click(button("remote.ux.back") ?? document.querySelector('[aria-label="common.cancel"]'));
	expect(connect).not.toHaveBeenCalled();
});

it("captures a switch confirmation and only switches after approval", async () => {
	const { capture, switchConnection } = await mount(true);
	await click(document.querySelector('[role="switch"][aria-label="remote.connect second"]'));
	expect(capture).toHaveBeenCalledWith("b");
	expect(switchConnection).not.toHaveBeenCalled();
	await click(button("remote.ux.switchAction"));
	expect(switchConnection).toHaveBeenCalledWith({
		epoch: "run",
		generation: 1,
		connectionId: "b",
		currentConnectionId: "a",
	});
});

it("captures the record revision when removal is confirmed", async () => {
	const { forget } = await mount();
	await click(document.querySelector('[aria-label="remote.ux.more second"]'));
	await click(button("remote.forget"));
	expect(forget).not.toHaveBeenCalled();
	await act(async () =>
		useRemoteConnectionStore.setState({
			catalog: {
				...useRemoteConnectionStore.getState().catalog,
				records: [{ connectionId: "b", alias: "second", revision: 9 }],
			},
		}),
	);
	await click(button("remote.confirmForget"));
	expect(forget).toHaveBeenCalledWith({ epoch: "run", generation: 1, connectionId: "b", recordRevision: 4 });
});

it("captures the add observation and locks all discovery controls while saving", async () => {
	await mount();
	let release!: (id: string) => void;
	const add = vi.fn(
		() =>
			new Promise<string>((resolve) => {
				release = resolve;
			}),
	);
	await act(async () => useRemoteConnectionStore.setState({ add }));
	await click(button("remote.ux.add"));
	await click(document.querySelector('input[value="new-host"]'));
	await click(button("remote.ux.addConnect"));
	try {
		expect(add).toHaveBeenCalledWith("new-host", { epoch: "run", generation: 1, catalogRevision: 1 });
		expect(document.querySelector<HTMLButtonElement>('[aria-label="remote.refreshAliases"]')?.disabled).toBe(
			true,
		);
		expect((button("remote.ux.manual") as HTMLButtonElement).disabled).toBe(true);
	} finally {
		await act(async () => release("added"));
	}
});

it("removes the project child when validation hands over to the real trust layer", async () => {
	await mount(true);
	let release!: () => void;
	const openProject = vi.fn(() => {
		useRemoteConnectionStore.setState({ open: false });
		return new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	await act(async () => useRemoteConnectionStore.setState({ openProject }));
	await click(
		document.querySelector('[aria-label="remote.ux.addProject first"]') ?? button("remote.ux.addProject"),
	);
	// Submit the actual form through its controlled input.
	const input = document.querySelector<HTMLInputElement>("#remote-project-path");
	expect(input).not.toBeNull();
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "/remote/project");
		input?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await click(document.querySelector(".remote-modal-footer .remote-primary"));
	try {
		expect(document.querySelector(".remote-modal")).toBeNull();
	} finally {
		if (release) await act(async () => release());
	}
});
