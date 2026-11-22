// @vitest-environment happy-dom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

import { useChannelSubscriptionsStore } from "../../stores/channel-subscriptions";
import { useSessionsStore } from "../../stores/sessions";
import { ChannelSubscriptionPill } from "./ChannelSubscriptionPill";
import { type ChannelPillPresence, HIDDEN_PRESENCE } from "./channel-pill-presence";

/**
 * 胶囊的 SSR 装配：每频道独立展示、名字原样、长名省略、退场期间 DOM 仍在。
 * 动画时长/关键帧/几何不属于 SSR 能断言的范围 —— 那部分由 scripts/verify-channel-pill.mjs 在真机上量。
 */
const presence = (patch: Partial<ChannelPillPresence>): ChannelPillPresence => ({
	...HIDDEN_PRESENCE,
	...patch,
});
const markup = (state: ChannelPillPresence) =>
	renderToStaticMarkup(<ChannelSubscriptionPill presence={state} onExitFinished={() => {}} />);

beforeEach(() => {
	vi.stubGlobal("React", React); // classic JSX：给产品文件提供 React 全局（仅本文件）
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());

describe("ChannelSubscriptionPill（SSR 装配）", () => {
	it("显示每个频道的权威非零未读数", async () => {
		useSessionsStore.setState({ activeSessionId: "s1" });
		useChannelSubscriptionsStore.getState().apply({
			sessionId: "s1",
			live: true,
			generation: 1,
			revision: 1,
			topics: ["alpha", "beta"],
			unreadCounts: { alpha: 12, beta: 3 },
		});
		const container = document.createElement("div");
		const root = createRoot(container);
		await act(() =>
			root.render(
				<ChannelSubscriptionPill
					presence={presence({ display: ["alpha", "beta"], opened: true, mounted: true })}
					onExitFinished={() => {}}
				/>,
			),
		);
		const pills = container.querySelectorAll("[data-channel-topic]");
		expect(pills).toHaveLength(2);
		expect(pills[0]?.textContent).toBe("alpha12");
		expect(pills[1]?.textContent).toBe("beta3");
		await act(() => root.unmount());
	});
	it("没挂载就什么都不渲染", () => {
		expect(markup(HIDDEN_PRESENCE)).toBe("");
	});

	it("展开态：每个频道独立一个胶囊，名字原样且不用间隔点", () => {
		const html = markup(presence({ display: ["alpha", "beta-gamma"], opened: true, mounted: true }));
		expect(html).toContain("channel-pill");
		expect(html).toContain("channel-pill-open"); // 展开类
		expect(html).toContain("alpha");
		expect(html).toContain("beta-gamma"); // 原样（不改写/不翻译）
		expect(html).not.toContain("·");
		expect(html).toContain("rounded-full"); // 胶囊形状
		expect(html).toContain("bg-surface");
		expect(html).toContain("shadow-pop"); // 无边框靠阴影分层
		expect(html).not.toContain("border"); // 禁边框
		expect(html.match(/data-channel-topic=/g)).toHaveLength(2);
		expect(html.match(/channel-pill /g)).toHaveLength(2);
	});

	it("最多五个频道靠右单列展示，一频道一行，不折叠", () => {
		const topics = ["alpha", "beta", "design", "research", "review"];
		const html = markup(presence({ display: topics, opened: true, mounted: true }));
		expect(html.match(/data-channel-topic=/g)).toHaveLength(5);
		for (const topic of topics) expect(html).toContain(`data-channel-topic="${topic}"`);
		expect(html).toContain("flex-col");
		expect(html).toContain("items-end");
		expect(html).not.toContain("flex-wrap");
	});

	it("单个频道时不出现间隔点", () => {
		const html = markup(presence({ display: ["alpha"], opened: true, mounted: true }));
		expect(html).not.toContain("·");
	});

	it("长名字：限制最大宽度 + 省略号（truncate），并提供 Tooltip 显示完整名称", () => {
		const long = "extremely-long-channel-name-that-should-be-truncated-in-the-pill";
		const html = markup(presence({ display: [long], opened: true, mounted: true }));
		expect(html).toContain("max-width:160px"); // 首帧兜底上限（运行时会按可用宽进一步夹取）
		expect(html).toContain("truncate");
		expect(html).toContain('role="tooltip"');
		expect(html).toContain(long); // Tooltip 里给完整名
		// 右缘元素：气泡右对齐，避免向右溢出撑出横向滚动条
		expect(html).toContain("right-0");
	});

	it("退场期间：DOM 仍在、保留退场文本、去掉展开类、且 aria-hidden", () => {
		const html = markup(presence({ display: ["alpha"], opened: false, mounted: true }));
		expect(html).toContain("alpha");
		expect(html).not.toContain("channel-pill-open");
		expect(html).toContain('aria-hidden="true"');
	});

	it("字号/颜色只走语义 token（text-ui-12 / ink-dim / ink-faint）", () => {
		const html = markup(presence({ display: ["alpha"], opened: true, mounted: true }));
		expect(html).toContain("text-ui-12");
		expect(html).toContain("text-ink-dim");
		expect(html).toContain("text-ink-faint");
		expect(html).not.toMatch(/text-\[\d+px\]/);
	});
});
