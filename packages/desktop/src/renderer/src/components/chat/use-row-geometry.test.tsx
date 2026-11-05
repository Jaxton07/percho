// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RowPositions } from "./row-positions";
import { useRowGeometry } from "./use-row-geometry";
import { windowFor } from "./virtual-window";

it("reconnects mounted rows after StrictMode and A → B → A; ignores disconnected observers", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const observers: MockObserver[] = [];
	class MockObserver {
		targets = new Set<Element>();
		disconnected = false;
		constructor(private callback: ResizeObserverCallback) {
			observers.push(this);
		}
		observe(target: Element) {
			this.targets.add(target);
		}
		unobserve(target: Element) {
			this.targets.delete(target);
		}
		disconnect() {
			this.disconnected = true;
			this.targets.clear();
		}
		fire(target: Element) {
			this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
		}
	}
	vi.stubGlobal("ResizeObserver", MockObserver);
	let height = 100;
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => new DOMRect(0, 0, 100, height),
	);
	const changed = vi.fn();
	let current: RowPositions;
	function Probe({ session }: { session: string }) {
		const content = useRef<HTMLDivElement>(null);
		const scroll = useRef<HTMLDivElement>(null);
		const positions = useMemo(() => {
			const p = new RowPositions(0);
			p.sync([{ key: session, kind: "user" }]);
			return p;
		}, [session]);
		current = positions;
		useRowGeometry(content, scroll, positions, "1", session, 0, 1, 0, false, changed, () => {});
		return (
			<div ref={scroll}>
				<div ref={content}>
					<div data-chat-row-key={session}>
						<div style={{ margin: 0 }}>row</div>
					</div>
				</div>
			</div>
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const render = (session: string) =>
		act(() =>
			root.render(
				<StrictMode>
					<Probe session={session} />
				</StrictMode>,
			),
		);
	try {
		await render("A");
		const first = observers.findLast((o) =>
			[...o.targets].some((target) => target.parentElement?.dataset.chatRowKey === "A"),
		)!;
		const firstTarget = [...first.targets][0]!;
		await act(() => first.fire(firstTarget));
		expect(current!.heightOf(0)).toBe(100);
		await render("B");
		expect(first.disconnected).toBe(true);
		await render("A");
		const latest = observers.findLast((o) =>
			[...o.targets].some((target) => target.parentElement?.dataset.chatRowKey === "A"),
		)!;
		const target = [...latest.targets][0]!;
		height = 175;
		await act(() => latest.fire(target));
		expect(current!.heightOf(0)).toBe(175);
		const calls = changed.mock.calls.length;
		await act(() => first.fire(firstTarget));
		expect(changed).toHaveBeenCalledTimes(calls);
	} finally {
		await act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

it("keeps a middle anchor mounted across a large prefix invalidation", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const observers: ResizeObserverCallback[] = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				observers.push(callback);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	let width = 500;
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	const positions = new RowPositions(0);
	const rows = Array.from({ length: 3000 }, (_, i) => ({ key: String(i), kind: "user" as const }));
	positions.sync(rows);
	for (const row of rows) positions.setHeight(row.key, 200);
	let scroller: HTMLDivElement;
	let viewport = 1500 * 200 + 20;
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.dataset.testScroll) return new DOMRect(0, 0, 500, 400);
		if (this.dataset.rowTop)
			return new DOMRect(0, Number(this.dataset.rowTop) - scroller.scrollTop, 500, 200);
		return new DOMRect(0, 0, 500, 0);
	});
	function Probe() {
		const content = useRef<HTMLDivElement>(null);
		const scroll = useRef<HTMLDivElement>(null);
		const [tick, setTick] = useState(0);
		const window = windowFor(positions, viewport, 400, false);
		useRowGeometry(
			content,
			scroll,
			positions,
			"1",
			rows,
			window.start,
			window.end,
			tick,
			false,
			() => setTick((n) => n + 1),
			() =>
				requestAnimationFrame(() => {
					viewport = scroller.scrollTop;
					setTick((n) => n + 1);
				}),
		);
		return (
			<div
				ref={(node) => {
					scroll.current = node;
					if (node) scroller = node;
				}}
				data-test-scroll="yes"
			>
				<div ref={content}>
					{rows.slice(window.start, window.end).map((row, i) => (
						<div key={row.key} data-chat-row-key={row.key}>
							<div style={{ margin: 0 }} data-row-top={positions.offsetOf(window.start + i)} />
						</div>
					))}
				</div>
			</div>
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(() => root.render(<Probe />));
		scroller!.scrollTop = viewport;
		width = 400;
		await act(() => observers[1]!([], {} as ResizeObserver));
		expect(scroller!.scrollTop).toBe(positions.offsetOf(1500) + 20);
		await act(() => {
			const pending = [...frames.values()];
			frames.clear();
			for (const frame of pending) frame(0);
		});
		const anchor = container.querySelector('[data-chat-row-key="1500"] > div') as HTMLElement | null;
		expect(anchor).not.toBeNull();
		expect(anchor!.getBoundingClientRect().top).toBe(-20);
	} finally {
		await act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

it("pins the same row until restoration after the old scroll maximum clamps prefix growth", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const observers: ResizeObserverCallback[] = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				observers.push(callback);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	let width = 500;
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	const positions = new RowPositions(0);
	const rows = Array.from({ length: 3000 }, (_, i) => ({ key: String(i), kind: "user" as const }));
	positions.sync(rows);
	for (const row of rows) positions.setHeight(row.key, 20);
	let scroller: HTMLDivElement;
	let scrollTop = 2970 * 20 + 5;
	let max = positions.total() - 400;
	let viewport = scrollTop;
	let pinned: string | null = null;
	let restoredWhileMounted = false;
	let forceRender: () => void = () => {};
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.dataset.testScroll) return new DOMRect(0, 0, 500, 400);
		if (this.dataset.rowTop) {
			if (this.parentElement?.dataset.chatRowKey === "2970" && max > 100000) restoredWhileMounted = true;
			return new DOMRect(0, Number(this.dataset.rowTop) - scrollTop, 500, 20);
		}
		return new DOMRect(0, 0, 500, 0);
	});
	function Probe() {
		const content = useRef<HTMLDivElement>(null);
		const scroll = useRef<HTMLDivElement>(null);
		const [tick, setTick] = useState(0);
		forceRender = () => setTick((n) => n + 1);
		const normal = windowFor(positions, viewport, 400, false);
		const index = pinned === null ? -1 : positions.indexOfKey(pinned);
		const start = index < 0 ? normal.start : Math.min(normal.start, index);
		const end = index < 0 ? normal.end : Math.max(normal.end, index + 1);
		useLayoutEffect(() => {
			max = positions.total() - 400;
		});
		useRowGeometry(
			content,
			scroll,
			positions,
			"1",
			rows,
			start,
			end,
			tick,
			false,
			() => {
				viewport = scrollTop;
				setTick((n) => n + 1);
			},
			() => {
				viewport = scrollTop;
			},
			(key) => {
				pinned = key;
			},
		);
		return (
			<div
				ref={(node) => {
					scroll.current = node;
					if (node && node !== scroller) {
						scroller = node;
						Object.defineProperty(node, "scrollTop", {
							get: () => scrollTop,
							set: (value: number) => {
								scrollTop = Math.max(0, Math.min(value, max));
							},
						});
					}
				}}
				data-test-scroll="yes"
			>
				<div ref={content}>
					{rows.slice(start, end).map((row, i) => (
						<div key={row.key} data-chat-row-key={row.key}>
							<div style={{ margin: 0 }} data-row-top={positions.offsetOf(start + i)} />
						</div>
					))}
				</div>
			</div>
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(() => root.render(<Probe />));
		width = 400;
		await act(() => observers[1]!([], {} as ResizeObserver));
		expect(scrollTop).toBe(59600);
		expect(pinned).toBe("2970");
		await act(() => {
			const pending = [...frames.values()];
			frames.clear();
			for (const frame of pending) frame(0);
		});
		expect(restoredWhileMounted).toBe(true);
		expect(scrollTop).toBe(positions.offsetOf(2970) + 5);
		expect(pinned).toBeNull();
		viewport = 0;
		await act(() => forceRender());
		expect(container.querySelector('[data-chat-row-key="2970"]')).toBeNull();
	} finally {
		await act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

it("releases a pending reading anchor without restoring it during a jump", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const observers: ResizeObserverCallback[] = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: ResizeObserverCallback) {
				observers.push(callback);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("cancelAnimationFrame", () => {});
	let width = 500;
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => new DOMRect(0, 0, 500, 400),
	);
	const positions = new RowPositions(0);
	const rows = [{ key: "row", kind: "user" as const }];
	positions.sync(rows);
	const pin = vi.fn();
	let scroller: HTMLDivElement;
	function Probe({ jumping }: { jumping: boolean }) {
		const content = useRef<HTMLDivElement>(null);
		const scroll = useRef<HTMLDivElement>(null);
		useRowGeometry(
			content,
			scroll,
			positions,
			"1",
			rows,
			0,
			1,
			Number(jumping),
			false,
			() => {},
			() => {},
			pin,
			() => !jumping,
		);
		return (
			<div
				ref={(node) => {
					scroll.current = node;
					if (node) scroller = node;
				}}
			>
				<div ref={content}>
					<div data-chat-row-key="row">
						<div style={{ margin: 0 }} />
					</div>
				</div>
			</div>
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(() => root.render(<Probe jumping={false} />));
		width = 400;
		await act(() => observers[1]!([], {} as ResizeObserver));
		expect(pin).toHaveBeenLastCalledWith("row");
		scroller!.scrollTop = 123;
		await act(() => root.render(<Probe jumping />));
		expect(scroller!.scrollTop).toBe(123);
		expect(pin).toHaveBeenLastCalledWith(null);
		width = 300;
		await act(() => observers[1]!([], {} as ResizeObserver));
		expect(scroller!.scrollTop).toBe(123);
		expect(pin).toHaveBeenLastCalledWith(null);
	} finally {
		await act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

it("restores the last stable offset when CSS reflows before the version changes", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	const positions = new RowPositions(0);
	const rows = [{ key: "target", kind: "user" as const }];
	positions.sync(rows);
	let scroller: HTMLDivElement;
	let rowTop = 112.2;
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.dataset.testScroll) return new DOMRect(0, 0, 500, 400);
		if (this.dataset.testRow) return new DOMRect(0, rowTop - scroller.scrollTop, 500, 200);
		return new DOMRect(0, 0, 500, 0);
	});
	function Probe({ version }: { version: string }) {
		const content = useRef<HTMLDivElement>(null);
		const scroll = useRef<HTMLDivElement>(null);
		const [tick, setTick] = useState(0);
		useRowGeometry(
			content,
			scroll,
			positions,
			version,
			rows,
			0,
			1,
			tick,
			false,
			() => setTick((n) => n + 1),
			() => {},
		);
		return (
			<div
				ref={(node) => {
					scroll.current = node;
					if (node) scroller = node;
				}}
				data-test-scroll="yes"
			>
				<div ref={content}>
					<div data-chat-row-key="target">
						<div data-test-row="yes" style={{ margin: 0 }} />
					</div>
				</div>
			</div>
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(() => root.render(<Probe version="1" />));
		scroller!.scrollTop = 100;
		await act(() => scroller.dispatchEvent(new Event("scroll")));
		rowTop += 153.2; // CSS has already changed the DOM before React observes the version.
		await act(() => root.render(<Probe version="2" />));
		await act(() => {
			const pending = [...frames.values()];
			frames.clear();
			for (const frame of pending) frame(0);
		});
		expect(container.querySelector<HTMLElement>("[data-test-row]")!.getBoundingClientRect().top).toBeCloseTo(
			12.2,
		);
	} finally {
		await act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

it("refreshes on container resize and invalidates offscreen heights on column width change", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			targets = new Set<Element>();
			constructor(callback: ResizeObserverCallback) {
				observers.push({ callback, targets: this.targets });
			}
			observe(target: Element) {
				this.targets.add(target);
			}
			unobserve(target: Element) {
				this.targets.delete(target);
			}
			disconnect() {
				this.targets.clear();
			}
		},
	);
	let width = 500;
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => new DOMRect(0, 0, 100, 100),
	);
	const positions = new RowPositions(0);
	positions.sync([
		{ key: "visible", kind: "user" },
		{ key: "offscreen", kind: "user" },
	]);
	positions.setHeight("offscreen", 300);
	const resized = vi.fn();
	function Probe() {
		const content = useRef<HTMLDivElement>(null);
		const scroll = useRef<HTMLDivElement>(null);
		const [tick, setTick] = useState(0);
		useRowGeometry(
			content,
			scroll,
			positions,
			"1",
			positions,
			0,
			1,
			tick,
			true,
			() => setTick((n) => n + 1),
			resized,
		);
		return (
			<div ref={scroll}>
				<div ref={content}>
					<div data-chat-row-key="visible">
						<div style={{ margin: 0 }}>row</div>
					</div>
				</div>
			</div>
		);
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(() => root.render(<Probe />));
		const observer = observers[1];
		if (!observer) throw new Error("missing container observer");
		await act(() => observer.callback([], {} as ResizeObserver));
		expect(resized).toHaveBeenCalledTimes(1);
		expect(positions.heightOf(1)).toBe(300);
		width = 400;
		await act(() => observer.callback([], {} as ResizeObserver));
		expect(resized).toHaveBeenCalledTimes(2);
		expect(positions.heightOf(0)).toBe(100);
		expect(positions.heightOf(1)).toBe(72);
	} finally {
		await act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
