// @vitest-environment happy-dom
import type { ComposerDocument } from "@percho/shared";
import { UNDO_COMMAND } from "lexical";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	show: vi.fn(async (_args: { token: string; x: number; y: number }) => {}),
	cancel: vi.fn(async (_args: { token: string }) => {}),
}));
vi.mock("../../api", () => ({
	getPi: () => ({ showComposerEditMenu: fixture.show, cancelComposerEditMenu: fixture.cancel }),
}));

import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";
import { $readComposerSelection, $selectComposerRange } from "./editor-document";
import { getComposerEditor, releaseComposerEditor } from "./editor-host";
import { fileReferencePart } from "./paste-files";

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

async function renderWithHandle(draftKey: string, document: ComposerDocument) {
	const ref = createRef<ComposerEditorHandle>();
	await act(async () =>
		root.render(
			<ComposerEditor
				ref={ref}
				draftKey={draftKey}
				readOnly={false}
				document={document}
				placeholder="Fixture"
				onChange={noop}
				onSelectionChange={noop}
				onKeyDown={noop}
				onPaste={noop}
			/>,
		),
	);
	return ref;
}

/** 直接读内核状态：组件不一定重渲染，onChange 也已经交给上层草稿。 */
function readComposer(draftKey: string) {
	let document: ComposerDocument = empty;
	let text = "";
	getComposerEditor(draftKey, empty)
		.editor.getEditorState()
		.read(() => {
			({ document, text } = $readComposerSelection());
		});
	return { document, text };
}

afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(container);
	for (const key of ["menu-one", "menu-two", "paste-caret", "paste-selection", "paste-undo"])
		releaseComposerEditor(key);
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

describe("paste insertion", () => {
	it("inserts references at the caret instead of appending", async () => {
		const handle = await renderWithHandle("paste-caret", {
			version: 1,
			parts: [{ type: "text", text: "ab" }],
		});

		await act(async () => handle.current?.focus(1));
		const range = handle.current?.selectionRange();
		expect(range).toEqual({ start: 1, end: 1 });

		await act(async () => handle.current?.insertReferences([fileReferencePart("/tmp/report.pdf")], range));
		expect(readComposer("paste-caret").document.parts).toEqual([
			{ type: "text", text: "a" },
			{ type: "file", path: "/tmp/report.pdf", label: "report.pdf" },
			{ type: "text", text: " b" },
		]);
	});

	it("replaces the current selection", async () => {
		const handle = await renderWithHandle("paste-selection", {
			version: 1,
			parts: [{ type: "text", text: "hello world" }],
		});
		const entry = getComposerEditor("paste-selection", empty);

		await act(async () => entry.editor.update(() => $selectComposerRange(0, 6)));
		const range = handle.current?.selectionRange();
		expect(range).toEqual({ start: 0, end: 6 });

		await act(async () => handle.current?.insertReferences([fileReferencePart("/tmp/report.pdf")], range));
		expect(readComposer("paste-selection").text).toBe("@report.pdf world");
	});

	it("restores the text with a single undo", async () => {
		const handle = await renderWithHandle("paste-undo", {
			version: 1,
			parts: [{ type: "text", text: "ab" }],
		});

		await act(async () => handle.current?.focus(1));
		await act(async () =>
			handle.current?.insertReferences(
				[fileReferencePart("/tmp/report.pdf")],
				handle.current.selectionRange(),
			),
		);
		expect(readComposer("paste-undo").text).toBe("a@report.pdf b");

		const entry = getComposerEditor("paste-undo", empty);
		await act(async () => {
			expect(entry.editor.dispatchCommand(UNDO_COMMAND, undefined)).toBe(true);
		});
		expect(readComposer("paste-undo").document).toEqual({
			version: 1,
			parts: [{ type: "text", text: "ab" }],
		});
	});
});
