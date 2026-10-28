import { RUNTIME_NODE_RANGE } from "@percho/shared";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../../i18n/en";
import { zh } from "../../i18n/zh";

const fixture = vi.hoisted(() => ({ language: "zh", openExternal: vi.fn() }));
vi.mock("../../api", () => ({ getPi: () => ({ openExternal: fixture.openExternal }) }));
vi.mock("../../i18n", () => ({
	useT:
		() =>
		(key: string, params: Record<string, string> = {}) => {
			let value: unknown = fixture.language === "zh" ? zh : en;
			for (const part of key.split(".")) value = (value as Record<string, unknown>)[part];
			return (value as string).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? "");
		},
}));

import { RemoteConnectionError } from "./RemoteConnectionError";

beforeEach(() => {
	vi.stubGlobal("React", React);
	fixture.language = "zh";
	vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("SSH Node requirement help", () => {
	it.each([
		"Error invoking remote method 'remote:connect': Error: NODE_REQUIRED: Install Node",
		"NODE_REQUIRED: Install Node in the non-interactive SSH environment",
	])("explains both IPC and status failures and keeps diagnostics collapsed: %s", (error) => {
		const html = renderToStaticMarkup(<RemoteConnectionError error={error} kind="requirements" />);
		expect(html).toContain(zh.remote.nodeRequired.title);
		expect(html).toContain(RUNTIME_NODE_RANGE.replaceAll(">", "&gt;"));
		expect(html).toContain(zh.remote.nodeRequired.pathHint);
		expect(html).not.toContain(zh.remote.failure.requirements);
		expect(html).toContain("<details");
		expect(html).not.toMatch(/<details[^>]*\sopen/);
		expect(html.indexOf("NODE_REQUIRED")).toBeGreaterThan(html.indexOf("<details"));
		expect(fixture.openExternal).not.toHaveBeenCalled();
	});
	it("provides English help and preserves other errors", () => {
		fixture.language = "en";
		expect(renderToStaticMarkup(<RemoteConnectionError error="NODE_REQUIRED" />)).toContain(
			en.remote.nodeRequired.title,
		);
		const html = renderToStaticMarkup(
			<RemoteConnectionError error="REQUIREMENTS: Missing commands: tar" kind="requirements" />,
		);
		expect(html).toContain(en.remote.failure.requirements);
		expect(html).toContain("Missing commands: tar");
		expect(html).not.toContain("<details");
		expect(renderToStaticMarkup(<RemoteConnectionError />)).toBe("");
	});
});
