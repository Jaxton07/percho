// @vitest-environment happy-dom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

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
