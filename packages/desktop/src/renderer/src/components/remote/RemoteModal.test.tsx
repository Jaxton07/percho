// @vitest-environment happy-dom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RemoteModal } from "./RemoteModal";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it.each(["body", "disabled", "inert", "removed"])(
	"uses the list entry when the previous target is %s",
	async (kind) => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const previous = document.createElement("button");
		document.body.append(previous);
		if (kind !== "body") previous.focus();
		else (document.activeElement as HTMLElement)?.blur();
		await act(async () =>
			root.render(
				<div>
					<div className="remote-list-header">
						<button type="button">List</button>
					</div>
					<RemoteModal title="Details" footer={null} onClose={() => {}}>
						Details
					</RemoteModal>
				</div>,
			),
		);
		if (kind === "disabled") previous.disabled = true;
		if (kind === "inert") previous.setAttribute("inert", "");
		if (kind === "removed") previous.remove();
		await act(async () =>
			root.render(
				<div>
					<div className="remote-list-header">
						<button type="button">List</button>
					</div>
				</div>,
			),
		);
		expect(document.activeElement).toBe(container.querySelector("button"));
		await act(async () => root.unmount());
		previous.remove();
		container.remove();
	},
);
