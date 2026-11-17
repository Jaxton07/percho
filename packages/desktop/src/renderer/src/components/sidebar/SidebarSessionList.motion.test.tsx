// @vitest-environment happy-dom
import type { SessionMeta } from "@percho/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useListShift } from "../../lib/use-list-shift";
import { SidebarSessionList } from "./SidebarSessionList";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
let container: HTMLDivElement;
let root: Root;
const animate = vi.fn();
const originalAnimate = HTMLElement.prototype.animate;
const props = {
	activeSessionId: null,
	emptyLabel: "empty",
	showMoreLabel: "more",
	hasMore: true,
	onShowMore: vi.fn(),
	onSelect: vi.fn(),
	onContextMenu: vi.fn(),
};
const sessions = (ids: string[]) =>
	ids.map((sessionId) => ({
		pinned: false,
		session: {
			sessionId,
			cwd: "/project",
			sessionFile: `/project/${sessionId}.jsonl`,
			name: sessionId,
			createdAt: 1,
			messageCount: 2,
			active: false,
		} satisfies SessionMeta,
	}));
const render = (ids: string[], loading = false, hasMore = true) =>
	act(() =>
		root.render(
			<SidebarSessionList
				{...props}
				hasMore={hasMore}
				sessions={sessions(ids)}
				paging={{ loading, partial: false, onRetry: vi.fn() }}
			/>,
		),
	);

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	animate.mockReset();
	animate.mockImplementation(
		() => ({ cancel: vi.fn(), onfinish: null, finished: Promise.resolve() }) as unknown as Animation,
	);
	Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
	vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
		const list = this.closest("[data-sidebar-session-list]");
		if (list) return [...list.children].indexOf(this) * 31;
		return this.matches("[data-sidebar-show-more]")
			? (this.parentElement?.querySelector("[data-sidebar-session-list]")?.children.length ?? 0) * 31
			: 0;
	});
	vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(0);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
		if (this.matches("[data-shift-key]")) return 31;
		const list = this.matches("[data-sidebar-session-list]")
			? this
			: this.querySelector("[data-sidebar-session-list]");
		return (
			(list?.children.length ?? 0) * 31 + (this.querySelector(":scope > [data-sidebar-show-more]") ? 31 : 0)
		);
	});
	vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: originalAnimate });
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function PlainList({ ids, skip = false }: { ids: string[]; skip?: boolean }) {
	const ref = useListShift({ skip });
	return (
		<div ref={ref} data-sidebar-session-list>
			{ids.map((id) => (
				<div key={id} data-shift-key={id}>
					{id}
				</div>
			))}
		</div>
	);
}

it("preserves the ordinary list's existing entrance fade", async () => {
	await act(() => root.render(<PlainList ids={["a", "b"]} />));
	await act(() => root.render(<PlainList ids={["a", "b", "c"]} />));
	expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], {
		duration: 140,
		easing: "cubic-bezier(0.2, 0, 0, 1)",
	});
});

it("skip cancels ordinary movement and entrance animations", async () => {
	await act(() => root.render(<PlainList ids={["a", "b"]} />));
	await act(() => root.render(<PlainList ids={["b", "c"]} />));
	const owned = animate.mock.results.map((result) => result.value as Animation);
	expect(owned).toHaveLength(2);
	await act(() => root.render(<PlainList ids={["b", "c"]} skip />));
	for (const animation of owned) expect(animation.cancel).toHaveBeenCalled();
});

it("preserves the drag-in-progress skip contract", async () => {
	await act(() => root.render(<PlainList ids={["a", "b"]} />));
	await act(() => root.render(<PlainList ids={["b", "c"]} skip />));
	expect(animate).not.toHaveBeenCalled();
	await act(() => root.render(<PlainList ids={["c", "d"]} />));
	expect(animate).not.toHaveBeenCalled();
	await act(() => root.render(<PlainList ids={["d", "e"]} />));
	expect(animate).toHaveBeenCalledWith(
		[{ transform: "translate(0px, 31px)" }, { transform: "translate(0px, 0px)" }],
		{ duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
	);
});

function CollapseList({ ids, skip = false }: { ids: string[]; skip?: boolean }) {
	const ref = useListShift({ collapse: true, skip });
	return (
		<div ref={ref} data-sidebar-session-list>
			{ids.map((id) => (
				<div key={id} data-shift-key={id}>
					{id}
				</div>
			))}
		</div>
	);
}

it.each(["skip", "reduced"] as const)(
	"%s cancels animations without reading geometry and resets the baseline",
	async (mode) => {
		vi.spyOn(performance, "now").mockReturnValue(0);
		const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
		const top = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")?.get);
		const left = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft")?.get);
		const height = vi.mocked(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")?.get);
		const show = (ids: string[], skip = false) =>
			act(() => root.render(<CollapseList ids={ids} skip={skip} />));
		await show(["a", "b", "c"]);
		await show(["a", "c"]);
		await show(["a", "c", "d"]);
		const owned = animate.mock.results.map((result) => result.value as Animation);
		expect(owned.length).toBeGreaterThan(2);
		animate.mockClear();
		top?.mockClear();
		left?.mockClear();
		height?.mockClear();
		rect.mockClear();
		if (mode === "reduced") vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
		await show(["c", "d"], mode === "skip");
		expect(top).not.toHaveBeenCalled();
		expect(left).not.toHaveBeenCalled();
		expect(height).not.toHaveBeenCalled();
		expect(rect).not.toHaveBeenCalled();
		for (const animation of owned) expect(animation.cancel).toHaveBeenCalled();
		expect(animate).not.toHaveBeenCalled();
		vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
		await show(["d", "e"]);
		expect(animate).not.toHaveBeenCalled();
		await show(["e"]);
		expect(animate).toHaveBeenCalledWith(
			[{ transform: "translate(0px, 31px)" }, { transform: "translate(0px, 0px)" }],
			{ duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
		);
	},
);

it("a page replacement also stops a previous collapse instead of extending its hidden phase", async () => {
	vi.spyOn(performance, "now").mockReturnValue(0);
	await render(["a", "b", "c", "d", "e", "f"]);
	await render(["c", "d", "e", "f", "g"]);
	const previousAnimations = animate.mock.results.map((result) => result.value as Animation);
	expect(previousAnimations.length).toBeGreaterThan(0);
	animate.mockClear();
	await render(["c", "h", "i", "j", "k"]);
	expect(animate).not.toHaveBeenCalled();
	for (const animation of previousAnimations) expect(animation.cancel).toHaveBeenCalled();
});

it("cached refresh keeps row nodes and the footer without inserting a loading row", async () => {
	await render(["a", "b", "c"]);
	const neighbor = container.querySelector('[data-session-id="c"]');
	await render(["a", "b", "c"], true);
	expect(container.textContent).not.toContain("sidebar.catalogLoading");
	expect(container.querySelector('[data-session-id="c"]')).toBe(neighbor);
	expect(container.querySelector<HTMLButtonElement>("[data-sidebar-show-more]")?.disabled).toBe(true);
	expect(animate).not.toHaveBeenCalled();
});

it("removing an archived row moves surviving rows from their previous layout before paint", async () => {
	await render(["a", "b", "c"]);
	const neighbor = container.querySelector('[data-session-id="c"]');
	await render(["a", "c"]);
	expect(container.querySelector('[data-session-id="b"]')).toBeNull();
	expect(container.querySelector('[data-session-id="c"]')).toBe(neighbor);
	expect(animate).toHaveBeenCalledWith(
		[{ transform: "translate(0px, 31px)" }, { transform: "translate(0px, 0px)" }],
		{ duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
	);
	const calls = animate.mock.calls.length;
	await render(["a", "c"], true);
	await render(["a", "c"]);
	expect(animate.mock.calls.length).toBe(calls);
});

it("backfilled rows wait for the collapse instead of overlapping the moving last row", async () => {
	await render(["a", "b", "c"]);
	await render(["a", "c"]);
	expect(animate).toHaveBeenCalledWith([{ height: "124px" }, { height: "93px" }], {
		duration: 220,
		easing: "cubic-bezier(0.2, 0, 0, 1)",
	});
	animate.mockClear();
	await render(["a", "c", "d"]);
	expect(animate).toHaveBeenCalledWith(
		[
			{ opacity: 0, visibility: "hidden" },
			{ opacity: 1, visibility: "visible" },
		],
		expect.objectContaining({ duration: 100, delay: expect.any(Number), fill: "backwards" }),
	);
});

it("replacing all six rows during a progressive refresh does not delay their entrance", async () => {
	await render(["a", "b", "c", "d", "e", "f"]);
	animate.mockClear();
	await render(["g", "h", "i", "j", "k", "l"]);
	expect(container.querySelectorAll("[data-session-id]")).toHaveLength(6);
	expect(animate).not.toHaveBeenCalledWith(
		[
			{ opacity: 0, visibility: "hidden" },
			{ opacity: 1, visibility: "visible" },
		],
		expect.objectContaining({ delay: expect.any(Number), fill: "backwards" }),
	);
});

it("ordinary show-more appends immediately without a collapse or delayed entrance", async () => {
	await render(["a", "b", "c"]);
	await render(["a", "b", "c", "d"]);
	expect(animate).not.toHaveBeenCalled();
});

it("expanding the final page does not treat the disappearing footer as an archived row", async () => {
	await render(["a", "b", "c"]);
	await render(["a", "b", "c", "d"], false, false);
	expect(container.querySelector("[data-sidebar-show-more]")).toBeNull();
	expect(animate).not.toHaveBeenCalled();
});

it("unmount cancels owned movement, size and delayed entrance animations", async () => {
	await render(["a", "b", "c"]);
	await render(["a", "c"]);
	await render(["a", "c", "d"]);
	const owned = animate.mock.results.map((result) => result.value as Animation);
	await act(() => root.unmount());
	for (const animation of owned) expect(animation.cancel).toHaveBeenCalled();
});

it("emptying the list clears old positions before the same identity appears again", async () => {
	await render(["a", "b", "c"]);
	await render(["a", "c"]);
	await render([]);
	animate.mockClear();
	await render(["c"]);
	expect(animate).not.toHaveBeenCalled();
});

it("enabling reduced motion cancels an in-flight collapse", async () => {
	await render(["a", "b", "c"]);
	await render(["a", "c"]);
	const owned = animate.mock.results.map((result) => result.value as Animation);
	vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
	await render(["a", "c"]);
	for (const animation of owned) expect(animation.cancel).toHaveBeenCalled();
});

it("reduced motion removes the row directly without a movement animation", async () => {
	vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
	await render(["a", "b", "c"]);
	await render(["a", "c"]);
	expect(container.querySelector('[data-session-id="b"]')).toBeNull();
	expect(animate).not.toHaveBeenCalled();
});
