// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSweepHighlight } from "./use-sweep-highlight";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
	await act(() => root?.unmount());
	container?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it("静态位置复用，滚动和宽度动画期间跟随，结束及卸载后停止重复读取", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const frames = new Map<number, FrameRequestCallback>();
	let serial = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++serial, callback);
		return serial;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	const disconnect = vi.fn();
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect = disconnect;
		},
	);
	let x = 100;
	const read = vi
		.spyOn(HTMLElement.prototype, "getBoundingClientRect")
		.mockImplementation(() => new DOMRect(x, 0, 100, 20));
	function Probe() {
		const { labelRef, wrapRef } = useSweepHighlight(true, "one");
		return (
			<>
				<span ref={labelRef}>working</span>
				<div ref={wrapRef}>
					<b data-shimmer-name="">write</b>
				</div>
			</>
		);
	}
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() => root!.render(<Probe />));
	async function tick(time: number) {
		await act(() => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(time);
		});
	}
	await tick(16);
	const initial = read.mock.calls.length;
	expect(initial).toBe(2);
	await tick(32);
	await tick(48);
	expect(read).toHaveBeenCalledTimes(initial);
	x = 120;
	await act(() => document.dispatchEvent(new Event("scroll")));
	await tick(64);
	expect(read).toHaveBeenCalledTimes(initial + 2);
	const event = (type: string) => {
		const value = new Event(type, { bubbles: true });
		Object.assign(value, { propertyName: "width" });
		return value;
	};
	await act(() => container!.dispatchEvent(event("transitionrun")));
	await tick(80);
	await tick(96);
	expect(read).toHaveBeenCalledTimes(initial + 6);
	await act(() => container!.dispatchEvent(event("transitionend")));
	await tick(112);
	const settled = read.mock.calls.length;
	await tick(128);
	expect(read).toHaveBeenCalledTimes(settled);
	const exiting = document.createElement("div");
	document.body.append(exiting);
	await act(() => exiting.dispatchEvent(event("transitionrun")));
	await tick(144);
	exiting.remove(); // A detached target's transitioncancel cannot bubble to document.
	await tick(160);
	const detached = read.mock.calls.length;
	await tick(176);
	expect(read).toHaveBeenCalledTimes(detached);
	await act(() => root!.render(null));
	expect(frames.size).toBe(0);
	expect(disconnect).toHaveBeenCalledOnce();
});
