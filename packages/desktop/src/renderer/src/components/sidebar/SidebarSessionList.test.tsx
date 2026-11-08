// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SidebarSessionList } from "./SidebarSessionList";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

it("分页加载、整理和失败时不误报空历史，并可重试", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	const root = createRoot(container);
	const retry = vi.fn();
	const props = {
		sessions: [],
		activeSessionId: null,
		emptyLabel: "empty",
		showMoreLabel: "more",
		hasMore: false,
		onShowMore: vi.fn(),
		onSelect: vi.fn(),
		onContextMenu: vi.fn(),
	};
	await act(() =>
		root.render(<SidebarSessionList {...props} paging={{ loading: true, partial: false, onRetry: retry }} />),
	);
	expect(container.textContent).toContain("sidebar.catalogLoading");
	expect(container.textContent).not.toContain("empty");
	await act(() =>
		root.render(<SidebarSessionList {...props} paging={{ loading: false, partial: true, onRetry: retry }} />),
	);
	expect(container.textContent).toContain("sidebar.catalogPartial");
	await act(() => container.querySelector("button")?.click());
	expect(retry).toHaveBeenCalledOnce();
	await act(() =>
		root.render(
			<SidebarSessionList
				{...props}
				paging={{ loading: false, partial: false, error: "offline", onRetry: retry }}
			/>,
		),
	);
	expect(container.textContent).toContain("sidebar.catalogRetry");
	expect(container.textContent).not.toContain("empty");
	await act(() => root.unmount());
	vi.unstubAllGlobals();
});
