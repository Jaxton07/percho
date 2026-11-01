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
	it.each(["zh", "en"])("%s 只显示 Worker 编号和状态圆点，状态保留无障碍标记", (language) => {
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
				? ["工作中", "排队中", "已完成", "失败", "已中止", "改动 1 个文件", "2 条命令失败", "高"]
				: ["Working", "Queued", "Done", "Failed", "Aborted", "1 files changed", "2 commands failed", "High"];
		for (const label of labels) expect(visibleText).not.toContain(label);
		for (let i = 1; i <= 5; i++) expect(visibleText).toContain(`Worker ${i}`);
		expect(html.match(/class="subagent-cap"/g)).toHaveLength(5);
		expect(html).toContain('data-state="running"');
		expect(html).toContain('data-state="queued"');
		expect(html).toContain('data-state="done"');
		expect(html).toContain('data-state="error"');
		expect(html).toContain('data-state="aborted"');
		expect(html.match(/<i><\/i>/g)).toHaveLength(15);
		expect(html).toContain(`aria-label="${language === "zh" ? "已完成" : "Done"}"`);
		expect(html).toContain(`title="Worker 3 · ${language === "zh" ? "已完成" : "Done"}"`);
		expect(html).not.toContain("message.subagent");
	});

	it("Worker 序号按卡片行号递增，不受重复 run.index 影响", () => {
		fixture.language = "zh";
		const runs = (["done", "error"] as const).map(
			(status, i): SubagentRunUi => ({ key: String(i), agent: "worker", status, index: 1 }),
		);
		const html = renderToStaticMarkup(<SubagentRunCard runs={runs} />);
		const visibleText = html.replace(/<[^>]*>/g, "");
		expect(visibleText).toContain("Worker 1");
		expect(visibleText).toContain("Worker 2");
		expect(visibleText).not.toContain("Worker 1Worker 1");
	});
});
