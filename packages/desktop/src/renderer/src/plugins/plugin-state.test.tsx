// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const pi = vi.hoisted(() => ({
	uiPluginsReadState: vi.fn(),
	uiPluginsWriteState: vi.fn(),
}));
vi.mock("../api", () => ({ getPi: () => pi }));

import {
	flushPluginStateWrites,
	PluginNameContext,
	resetPluginStateForTests,
	usePluginState,
} from "./plugin-state";

let host: HTMLDivElement;
let root: Root;
let seen: { value: { x: number }; ready: boolean }[];
let setter: ((next: { x: number } | ((p: { x: number }) => { x: number })) => void) | undefined;

function Probe() {
	const [value, set, ready] = usePluginState("offset", { x: 0 });
	setter = set;
	seen.push({ value, ready });
	return null;
}

const render = (name: string | null) =>
	act(() =>
		root.render(
			<PluginNameContext.Provider value={name}>
				<Probe />
			</PluginNameContext.Provider>,
		),
	);

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	resetPluginStateForTests();
	pi.uiPluginsReadState.mockReset();
	pi.uiPluginsWriteState.mockReset().mockResolvedValue({ ok: true });
	seen = [];
	setter = undefined;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

it("starts from the fallback, then shows the saved value once loaded", async () => {
	pi.uiPluginsReadState.mockResolvedValue({ offset: { x: -80 } });
	render("ds-whale-maid");
	expect(seen[0]).toEqual({ value: { x: 0 }, ready: false });
	await act(async () => {});
	expect(pi.uiPluginsReadState).toHaveBeenCalledWith({ name: "ds-whale-maid" });
	expect(seen.at(-1)).toEqual({ value: { x: -80 }, ready: true });
});

it("updates immediately but writes to disk once, 300ms after the last change", async () => {
	pi.uiPluginsReadState.mockResolvedValue({});
	render("ds-whale-maid");
	await act(async () => {});
	act(() => {
		for (let x = 1; x <= 20; x++) setter?.({ x });
	});
	expect(seen.at(-1)?.value).toEqual({ x: 20 });
	expect(pi.uiPluginsWriteState).not.toHaveBeenCalled();
	await act(async () => vi.advanceTimersByTime(299));
	expect(pi.uiPluginsWriteState).not.toHaveBeenCalled();
	await act(async () => vi.advanceTimersByTime(1));
	expect(pi.uiPluginsWriteState).toHaveBeenCalledOnce();
	expect(pi.uiPluginsWriteState).toHaveBeenCalledWith({
		name: "ds-whale-maid",
		key: "offset",
		value: { x: 20 },
	});
});

it("a change made while loading is not overwritten by the older value on disk", async () => {
	let resolveRead: (value: unknown) => void = () => {};
	pi.uiPluginsReadState.mockReturnValue(new Promise((resolve) => (resolveRead = resolve)));
	render("ds-whale-maid");
	act(() => setter?.({ x: 5 }));
	await act(async () => resolveRead({ offset: { x: -80 } }));
	expect(seen.at(-1)).toEqual({ value: { x: 5 }, ready: true });
});

it("flush writes pending changes right away (window closing)", async () => {
	pi.uiPluginsReadState.mockResolvedValue({});
	render("ds-whale-maid");
	await act(async () => {});
	act(() => setter?.((p) => ({ x: p.x + 7 })));
	flushPluginStateWrites();
	expect(pi.uiPluginsWriteState).toHaveBeenCalledWith({
		name: "ds-whale-maid",
		key: "offset",
		value: { x: 7 },
	});
	await act(async () => vi.advanceTimersByTime(1000));
	expect(pi.uiPluginsWriteState).toHaveBeenCalledOnce();
});

it("outside a plugin boundary it is an in-memory no-op and never touches IPC", async () => {
	render(null);
	await act(async () => {});
	act(() => setter?.({ x: 3 }));
	await act(async () => vi.advanceTimersByTime(1000));
	expect(seen.at(-1)).toEqual({ value: { x: 0 }, ready: true });
	expect(pi.uiPluginsReadState).not.toHaveBeenCalled();
	expect(pi.uiPluginsWriteState).not.toHaveBeenCalled();
});

it("a failed read still becomes ready with the fallback", async () => {
	pi.uiPluginsReadState.mockRejectedValue(new Error("ipc down"));
	vi.spyOn(console, "warn").mockImplementation(() => {});
	render("ds-whale-maid");
	await act(async () => {});
	expect(seen.at(-1)).toEqual({ value: { x: 0 }, ready: true });
});
