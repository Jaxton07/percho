import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../../i18n/en";
import { zh } from "../../i18n/zh";

const fixture = vi.hoisted(() => ({ language: "zh" }));
vi.mock("../../i18n", () => ({
	useT: () => (key: string) => {
		let value: unknown = fixture.language === "zh" ? zh : en;
		for (const part of key.split(".")) value = (value as Record<string, unknown>)[part];
		return value as string;
	},
}));

import { CompactionPauseNote } from "./CompactionPauseNote";

beforeEach(() => {
	vi.stubGlobal("React", React);
	fixture.language = "zh";
});
afterEach(() => vi.unstubAllGlobals());

describe("compaction pause feedback", () => {
	it.each(["failed", "still-over-threshold", "nothing-to-compact", "context-changed"] as const)(
		"explains %s and how to resume without exposing a retry-answer action",
		(reason) => {
			const html = renderToStaticMarkup(
				<CompactionPauseNote pause={{ reason, errorMessage: "diagnostic" }} />,
			);
			expect(html).toContain("任务已暂停");
			expect(html).toContain(zh.compaction.paused.resumeHint);
			expect(html).toContain("diagnostic");
			expect(html).not.toContain("<button");
		},
	);
	it("provides the same recovery instructions in English", () => {
		fixture.language = "en";
		const html = renderToStaticMarkup(<CompactionPauseNote pause={{ reason: "failed" }} />);
		expect(html).toContain(en.compaction.paused.failed);
		expect(html).toContain(en.compaction.paused.resumeHint);
	});
});
