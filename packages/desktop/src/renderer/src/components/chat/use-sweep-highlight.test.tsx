// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useSweepHighlight } from "./use-sweep-highlight";

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing expected element or root");
	return value;
}

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
	await act(() => root?.unmount());
	container?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it("无标签时延迟工具目标仍扫光，切换标签及卸载清理", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const frames = new Map<number, FrameRequestCallback>();
	let serial = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++serial, callback);
		return serial;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	const read = vi
		.spyOn(HTMLElement.prototype, "getBoundingClientRect")
		.mockReturnValue(new DOMRect(10, 0, 100, 20));
	function Probe({ mode }: { mode: string }) {
		const { labelRef, wrapRef } = useSweepHighlight(true, mode);
		return (
			<>
				{mode === "thinking" && <span ref={labelRef}>thinking</span>}
				<div ref={wrapRef}>{mode === "tool" && <b data-shimmer-name="">tool</b>}</div>
			</>
		);
	}
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() => required(root).render(<Probe mode="empty" />));
	await act(() => required(root).render(<Probe mode="tool" />));
	const tool = required(container.querySelector("b"));
	expect(read.mock.instances).toContain(tool);
	await act(() => required(root).render(<Probe mode="thinking" />));
	expect(tool.style.backgroundImage).toBe("");
	const label = required(container.querySelector("span"));
	expect(read.mock.instances).toContain(label);
	await act(() => required(root).render(null));
	expect(label.style.backgroundImage).toBe("");
	expect(frames.size).toBe(0);
});

it("目标容器延迟挂载且标识不变时仍启动，替换标签后不再读取旧节点", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const frames = new Map<number, FrameRequestCallback>();
	let serial = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++serial, callback);
		return serial;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	const read = vi
		.spyOn(HTMLElement.prototype, "getBoundingClientRect")
		.mockReturnValue(new DOMRect(10, 0, 100, 20));
	function Probe({ mode }: { mode: "empty" | "thinking" | "tool" }) {
		const { labelRef, wrapRef } = useSweepHighlight(true, "unchanged");
		if (mode === "empty") return null;
		return (
			<div ref={wrapRef}>
				{mode === "thinking" ? <span ref={labelRef}>thinking</span> : <b data-shimmer-name="">tool</b>}
			</div>
		);
	}
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const render = async (mode: "empty" | "thinking" | "tool") =>
		act(() => root?.render(<Probe mode={mode} />));
	const tick = async () =>
		act(() => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(performance.now());
		});
	await render("empty");
	await tick();
	await render("thinking");
	const label = container.querySelector("span");
	if (!label) throw new Error("Missing thinking label");
	await tick();
	expect(read.mock.instances).toContain(label);
	await render("tool");
	read.mockClear();
	await tick();
	const tool = container.querySelector("b");
	if (!tool) throw new Error("Missing tool name");
	expect(read.mock.instances).toContain(tool);
	expect(read.mock.instances).not.toContain(label);
	expect(label.style.backgroundImage).toBe("");
});

it("减少动态效果时保留可读文字且不启动扫光", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
	const raf = vi.fn();
	vi.stubGlobal("requestAnimationFrame", raf);
	function Probe() {
		const { wrapRef } = useSweepHighlight(true, "tool");
		return (
			<div ref={wrapRef}>
				<b data-shimmer-name="">tool</b>
			</div>
		);
	}
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() => required(root).render(<Probe />));
	expect(container.textContent).toBe("tool");
	expect(container.querySelector("b")?.style.backgroundImage).toBe("");
	expect(raf).not.toHaveBeenCalled();
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
	await act(() => required(root).render(<Probe />));
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
	await act(() => required(container).dispatchEvent(event("transitionrun")));
	await tick(80);
	await tick(96);
	expect(read).toHaveBeenCalledTimes(initial + 6);
	await act(() => required(container).dispatchEvent(event("transitionend")));
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
	await act(() => required(root).render(null));
	expect(frames.size).toBe(0);
	expect(disconnect).toHaveBeenCalledOnce();
});
