import type { SubagentRunUi } from "@percho/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { en } from "../../i18n/en";
import { zh } from "../../i18n/zh";

const fixture = vi.hoisted(() => ({ language: "zh" }));
vi.mock("../../stores/sessions", () => ({ useSessionsStore: () => () => {} }));
vi.mock("../../lib/session-page-slide", () => ({ withSessionSlide: () => {} }));
vi.mock("../../i18n", () => ({
	useT:
		() =>
		(key: string, params: Record<string, string | number> = {}) => {
			let value: unknown = fixture.language === "zh" ? zh : en;
			for (const part of key.split(".")) value = (value as Record<string, unknown>)[part];
			return (value as string).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
		},
}));

import { SubagentRunCard } from "./SubagentRunCard";

describe("子代理卡片文案", () => {
	it.each(["zh", "en"])("%s 只显示名称和思考档位，状态保留无障碍标记", (language) => {
		fixture.language = language;
		const runs = (["running", "queued", "done", "error", "aborted"] as const).map(
			(status, i): SubagentRunUi => ({
				key: String(i),
				agent: "worker",
				status,
				index: i + 1,
				thinkingLevel: "high",
				summary: {
					changedFiles: [{ path: "file", added: 1, removed: 0 }],
					commands: [],
					failedCommands: 2,
					durationMs: 5,
				},
			}),
		);
		const html = renderToStaticMarkup(<SubagentRunCard runs={runs} />);
		const visibleText = html.replace(/<[^>]*>/g, "");
		const labels =
			language === "zh"
				? ["工作中", "排队中", "已完成", "失败", "已中止", "改动 1 个文件", "2 条命令失败"]
				: ["Working", "Queued", "Done", "Failed", "Aborted", "1 files changed", "2 commands failed"];
		for (const label of labels) expect(visibleText).not.toContain(label);
		expect(html).toContain(`aria-label="${language === "zh" ? "已完成" : "Done"}"`);
		expect(visibleText).toContain(language === "zh" ? "高" : "High");
		expect(html).toContain("Worker");
		expect(html).not.toContain("message.subagent");
	});
});
