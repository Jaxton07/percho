import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("LAN 子代理状态", () => {
	it.each(["zh-CN", "en-US"])("%s 的排队和中止不会显示成绿色完成", async (language) => {
		vi.stubGlobal("navigator", { language });
		const { SubagentCard } = await import("./SubagentCard");
		const html = renderToStaticMarkup(
			createElement(SubagentCard, {
				runs: [
					{ key: "a", agent: "worker", status: "aborted" },
					{ key: "q", agent: "worker", status: "queued" },
				],
			}),
		);
		expect(html).toContain(language.startsWith("zh") ? "已中止" : "Aborted");
		expect(html).toContain(language.startsWith("zh") ? "排队中" : "Queued");
		const visibleText = html.replace(/<[^>]*>/g, "");
		expect(visibleText).not.toContain(language.startsWith("zh") ? "已中止" : "Aborted");
		expect(visibleText).not.toContain(language.startsWith("zh") ? "排队中" : "Queued");
		expect(html).not.toContain("agent-state ok");
		expect(html).toContain("Worker");
	});
});
