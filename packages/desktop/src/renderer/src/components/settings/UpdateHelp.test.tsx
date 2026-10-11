import type { UpdateDiagnosticsInfo } from "@percho/shared";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
	exportReport: vi.fn(),
	openExternal: vi.fn(),
	toast: vi.fn(),
	setBusy: vi.fn(),
}));
vi.mock("../../api", () => ({
	getPi: () => ({ exportUpdateDiagnostics: mock.exportReport, openExternal: mock.openExternal }),
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../stores/toasts", () => ({ pushToast: mock.toast }));
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof React>("react");
	return { ...actual, useState: (initial: unknown) => [initial, mock.setBusy] };
});

import { UpdateHelp } from "./UpdateHelp";

const props = {
	windows: true,
	repoUrl: "https://github.com/Jaxton07/percho",
	diagnostics: null as UpdateDiagnosticsInfo | null,
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("React", React);
});
afterEach(() => vi.unstubAllGlobals());
function buttons(element: React.ReactNode): Array<{ onClick: () => void; children: string }> {
	if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => void }>(element)) return [];
	if (element.type === "button") return [element.props as { onClick: () => void; children: string }];
	return React.Children.toArray(element.props.children).flatMap(buttons);
}
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("update recovery help", () => {
	it("offers Windows recovery, privacy information and explicit export/manual actions", () => {
		const html = renderToStaticMarkup(React.createElement(UpdateHelp, props));
		expect(html).toContain("update.windowsRecovery");
		expect(html).toContain("update.diagnosticsPrivacy");
		expect(html).toContain("update.exportDiagnostics");
		expect(mock.exportReport).not.toHaveBeenCalled();
	});
	it("only shows an unconfirmed-install note, never calls it a confirmed failure", () => {
		for (const previousInstall of ["none", "target-running", "version-changed", "unconfirmed"] as const) {
			const html = renderToStaticMarkup(
				React.createElement(UpdateHelp, {
					...props,
					windows: false,
					diagnostics: { previousInstall, targetVersion: "0.6.5" },
				}),
			);
			expect(html.includes("update.installUnconfirmed")).toBe(previousInstall === "unconfirmed");
			expect(html).not.toContain("update.windowsRecovery");
		}
	});
	it("exports only on click and reports the user-selected path", async () => {
		mock.exportReport.mockResolvedValue("C:\\诊断.json");
		buttons(UpdateHelp(props))[0]?.onClick();
		await flush();
		expect(mock.exportReport).toHaveBeenCalledOnce();
		expect(mock.toast).toHaveBeenCalledWith("info", "update.diagnosticsSaved", "C:\\诊断.json");
		expect(mock.setBusy).toHaveBeenLastCalledWith(false);
	});
	it("cancelled export is not reported as failure or uploaded", async () => {
		mock.exportReport.mockResolvedValue(null);
		buttons(UpdateHelp(props))[0]?.onClick();
		await flush();
		expect(mock.toast).not.toHaveBeenCalled();
		expect(mock.openExternal).not.toHaveBeenCalled();
	});
	it("reports export errors through the standard toast", async () => {
		mock.exportReport.mockRejectedValue(new Error("permission denied"));
		buttons(UpdateHelp(props))[0]?.onClick();
		await flush();
		expect(mock.toast).toHaveBeenCalledWith("error", "update.diagnosticsFailed", "permission denied");
	});
	it("manual download points to the official latest release, not a local executable", () => {
		buttons(UpdateHelp(props))[1]?.onClick();
		expect(mock.openExternal).toHaveBeenCalledWith({
			url: "https://github.com/Jaxton07/percho/releases/latest",
		});
	});
});
