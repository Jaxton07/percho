// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionViewStore } from "../../stores/session-view";
import { DeferredDetails, SessionViewContext } from "./DeferredDetails";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const expensive = vi.fn(() => <pre>synthetic details</pre>);
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	useSessionViewStore.setState({ bySession: {} });
	vi.stubGlobal("getComputedStyle", () => ({
		transitionProperty: "height",
		transitionDuration: "0.28s",
		transitionDelay: "0s",
	}));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	expensive.mockClear();
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
async function render(session = "one") {
	useSessionViewStore.getState().ensure(session);
	await act(() =>
		root.render(
			<SessionViewContext.Provider value={session}>
				<DeferredDetails viewKey="group" className="drawer-details" summary="open">
					{expensive}
				</DeferredDetails>
			</SessionViewContext.Provider>,
		),
	);
}
async function toggle() {
	await act(() =>
		container
			.querySelector("summary")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
	);
}
it("never builds folded details; closing retains animation then releases, and reopening cancels release", async () => {
	await render();
	expect(expensive).not.toHaveBeenCalled();
	await toggle();
	expect(container.querySelector("pre")).not.toBeNull();
	await toggle();
	expect(container.querySelector("pre")).not.toBeNull();
	await act(() => vi.advanceTimersByTime(200));
	await toggle();
	await act(() => vi.advanceTimersByTime(400));
	expect(container.querySelector("pre")).not.toBeNull();
	await toggle();
	await act(() => vi.advanceTimersByTime(350));
	expect(container.querySelector("pre")).toBeNull();
});
it("a matching transition end releases early but child transitions cannot release it", async () => {
	await render();
	await toggle();
	await toggle();
	const event = new Event("transitionend", { bubbles: true });
	Object.assign(event, { propertyName: "height", pseudoElement: "::details-content" });
	await act(() => container.querySelector("pre")?.dispatchEvent(event));
	expect(container.querySelector("pre")).not.toBeNull();
	await act(() => container.querySelector("details")?.dispatchEvent(event));
	expect(container.querySelector("pre")).toBeNull();
});
it("session switches retain independent open state and forgotten sessions start closed", async () => {
	await render();
	await toggle();
	await render("two");
	expect(container.querySelector("details")?.open).toBe(false);
	await render("one");
	expect(container.querySelector("details")?.open).toBe(true);
	await act(() => useSessionViewStore.getState().forget("one"));
	expect(container.querySelector("details")?.open).toBe(false);
});
it("does not run a closing timer after unmount", async () => {
	await render();
	await toggle();
	await toggle();
	await act(() => root.render(null));
	expect(vi.getTimerCount()).toBe(0);
});

it("reduced motion releases immediately; cancellation and missing events release safely", async () => {
	await render();
	await toggle();
	await toggle();
	const cancelled = new Event("transitioncancel", { bubbles: true });
	Object.assign(cancelled, { propertyName: "height", pseudoElement: "::details-content" });
	await act(() => container.querySelector("details")?.dispatchEvent(cancelled));
	expect(container.querySelector("pre")).toBeNull();
	await toggle();
	const match = window.matchMedia("(prefers-reduced-motion: reduce)");
	Object.defineProperty(match, "matches", { value: true });
	vi.spyOn(window, "matchMedia").mockReturnValue(match);
	await toggle();
	expect(container.querySelector("pre")).toBeNull();
});

it("主动关闭清理选区并只恢复明细内部的焦点，不影响外部编辑", async () => {
	await render();
	await toggle();
	const pre = container.querySelector("pre")!;
	pre.tabIndex = 0;
	pre.focus();
	const summary = container.querySelector("summary")!;
	summary.tabIndex = 0;
	const range = document.createRange();
	range.selectNodeContents(pre);
	window.getSelection()!.addRange(range);
	await toggle();
	expect(window.getSelection()!.toString()).toBe("");
	expect(document.activeElement).toBe(summary);
	const outside = document.createElement("input");
	container.append(outside);
	outside.focus();
	await toggle();
	await toggle();
	expect(document.activeElement).toBe(outside);
});

it("关闭时也清理跨过整个明细的选区，即使两个端点都在外部", async () => {
	await act(() =>
		root.render(
			<>
				<p>before</p>
				<DeferredDetails defaultOpen summary="open">
					{expensive}
				</DeferredDetails>
				<p>after</p>
			</>,
		),
	);
	const before = container.querySelector("p")?.firstChild;
	const after = container.querySelector("p:last-child")?.firstChild;
	const selection = window.getSelection();
	if (!before || !after || !selection) throw new Error("Missing selection fixture");
	const range = document.createRange();
	range.setStart(before, 1);
	range.setEnd(after, 2);
	selection.addRange(range);
	expect(selection.toString()).toContain("synthetic details");
	await toggle();
	expect(selection.toString()).toBe("");
	await toggle();
	range.setStart(before, 0);
	range.setEnd(before, 3);
	selection.addRange(range);
	await toggle();
	expect(selection.toString()).toBe("bef");
});
