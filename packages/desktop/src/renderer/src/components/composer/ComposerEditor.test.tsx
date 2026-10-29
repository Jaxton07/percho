// @vitest-environment happy-dom
import type { ComposerDocument } from "@percho/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	show: vi.fn(async (_args: { token: string; x: number; y: number }) => {}),
	cancel: vi.fn(async (_args: { token: string }) => {}),
}));
vi.mock("../../api", () => ({
	getPi: () => ({ showComposerEditMenu: fixture.show, cancelComposerEditMenu: fixture.cancel }),
}));

import { ComposerEditor } from "./ComposerEditor";
import { releaseComposerEditor } from "./editor-host";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
const empty: ComposerDocument = { version: 1, parts: [] };
const noop = () => {};
async function render(draftKey: string, readOnly = false, document = empty) {
	await act(async () =>
		root.render(
			<ComposerEditor
				draftKey={draftKey}
				readOnly={readOnly}
				document={document}
				placeholder="Fixture"
				onChange={noop}
				onSelectionChange={noop}
				onKeyDown={noop}
				onPaste={noop}
			/>,
		),
	);
}
function context() {
	const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 40 });
	container.querySelector("[contenteditable]")?.dispatchEvent(event);
	return event;
}
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(container);
	for (const key of ["menu-one", "menu-two"]) releaseComposerEditor(key);
	vi.clearAllMocks();
});
describe("composer menu ownership", () => {
	it("keeps native context delivery and invalidates the previous draft token", async () => {
		await render("menu-one");
		const event = context();
		expect(event.defaultPrevented).toBe(false);
		const first = fixture.show.mock.calls.at(-1)?.[0];
		expect(first).toMatchObject({ x: 20, y: 40 });
		await render("menu-two");
		expect(fixture.cancel).toHaveBeenCalledWith({ token: first?.token });
		context();
		expect(fixture.show.mock.calls.at(-1)?.[0]?.token).not.toBe(first?.token);
	});
	it("invalidates readonly changes, external document replacement and focus leaving the host", async () => {
		await render("menu-one");
		context();
		const first = fixture.show.mock.calls.at(-1)?.[0];
		await render("menu-one", true);
		expect(fixture.cancel).toHaveBeenCalledWith({ token: first?.token });
		context();
		const second = fixture.show.mock.calls.at(-1)?.[0];
		expect(second?.token).not.toBe(first?.token);
		fixture.cancel.mockClear();
		await render("menu-one", true, { version: 1, parts: [{ type: "text", text: "replacement" }] });
		expect(fixture.cancel).toHaveBeenCalledWith({ token: second?.token });
		fixture.cancel.mockClear();
		document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(fixture.cancel).toHaveBeenCalledWith({ token: second?.token });
	});
});
