// @vitest-environment happy-dom
import type { UIToolCall } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MetaGroup } from "./MetaGroup";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

let root: ReturnType<typeof createRoot> | undefined, container: HTMLDivElement | undefined;
afterEach(async () => {
	await act(() => root?.unmount());
	container?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it("500次单组按需展示，内部折叠不挂参数/输出，持续追加不破坏已选历史节点", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("getComputedStyle", () => ({
		transitionProperty: "none",
		transitionDuration: "0s",
		transitionDelay: "0s",
	}));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const tools: UIToolCall[] = Array.from({ length: 500 }, (_, index) => ({
		key: `tool-${index}`,
		id: `id-${index}`,
		name: "bash",
		args: JSON.stringify({ command: `echo ${index}` }),
		output: `output ${index}`,
		state: "done",
	}));
	const render = () =>
		act(() =>
			root!.render(<MetaGroup viewKey="synthetic" items={[{ thinking: "", tools }]} working={false} />),
		);
	await render();
	expect(container.querySelectorAll("details").length).toBe(1);
	expect(container.querySelector("pre")).toBeNull();
	const click = async (element: Element) =>
		act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
	await click(container.querySelector("summary")!);
	expect(container.querySelectorAll("details").length).toBe(501);
	expect(container.querySelector("pre")).toBeNull();
	const first = container.querySelector('[data-view-key="tool:tool-0"]')!;
	await click(first.querySelector("summary")!);
	expect(first.textContent).toContain("output 0");
	const output = first.querySelectorAll("pre")[1]!;
	const range = document.createRange();
	const selectedText = document.createTreeWalker(output, NodeFilter.SHOW_TEXT).nextNode();
	if (!selectedText) throw Error("Missing output text");
	range.setStart(selectedText, 0);
	range.setEnd(selectedText, selectedText.textContent?.length ?? 0);
	window.getSelection()!.addRange(range);
	tools.push({
		key: "new",
		id: "new",
		name: "bash",
		args: '{"command":"new"}',
		output: "new output",
		state: "running",
	});
	await render();
	expect(first.querySelectorAll("pre")[1]).toBe(output);
	expect(window.getSelection()!.toString()).toBe("output 0");
	expect(
		[...container.querySelectorAll("details[data-view-key]")].at(-1)?.getAttribute("data-view-key"),
	).toBe("tool:new");
	tools[0] = { ...tools[0]!, output: "output 0 appended" };
	await render();
	expect(output.textContent).toBe("output 0 appended");
	expect(window.getSelection()!.toString()).toBe("output 0");
	tools[0] = { ...tools[0]!, output: "updated output" };
	await render();
	expect(output.textContent).toBe("updated output");
	await click(container.querySelector("summary")!);
	expect(container.querySelector("pre")).toBeNull();
	await click(container.querySelector("summary")!);
	expect(container.querySelectorAll("details").length).toBe(502);
});
