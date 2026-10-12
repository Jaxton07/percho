import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));

import { ChannelSubscriptionPill } from "./ChannelSubscriptionPill";
import { type ChannelPillPresence, HIDDEN_PRESENCE } from "./channel-pill-presence";

/**
 * 胶囊的 SSR 装配（spec D2）：内容形态、名字原样、间隔点、长名省略、退场期间 DOM 仍在。
 * 动画时长/关键帧/几何不属于 SSR 能断言的范围 —— 那部分由 scripts/verify-channel-pill.mjs 在真机上量。
 */
const presence = (patch: Partial<ChannelPillPresence>): ChannelPillPresence => ({
	...HIDDEN_PRESENCE,
	...patch,
});
const markup = (state: ChannelPillPresence) =>
	renderToStaticMarkup(<ChannelSubscriptionPill presence={state} onExitFinished={() => {}} />);

beforeEach(() => vi.stubGlobal("React", React)); // classic JSX：给产品文件提供 React 全局（仅本文件）
afterEach(() => vi.unstubAllGlobals());

describe("ChannelSubscriptionPill（SSR 装配）", () => {
	it("没挂载就什么都不渲染", () => {
		expect(markup(HIDDEN_PRESENCE)).toBe("");
	});

	it("展开态：一个胶囊装多个频道，用间隔点分隔、名字原样不翻译", () => {
		const html = markup(presence({ display: ["alpha", "beta-gamma"], opened: true, mounted: true }));
		expect(html).toContain("channel-pill");
		expect(html).toContain("channel-pill-open"); // 展开类
		expect(html).toContain("alpha");
		expect(html).toContain("beta-gamma"); // 原样（不改写/不翻译）
		expect(html).toContain("·"); // 间隔点
		expect(html).toContain("rounded-full"); // 胶囊形状
		expect(html).toContain("bg-surface");
		expect(html).toContain("shadow-pop"); // 无边框靠阴影分层
		expect(html).not.toContain("border"); // 禁边框
		// 只有一个胶囊（多频道在同一枚里）
		expect(html.match(/channel-pill /g)?.length).toBe(1);
	});

	it("单个频道时不出现间隔点", () => {
		const html = markup(presence({ display: ["alpha"], opened: true, mounted: true }));
		expect(html).not.toContain("·");
	});

	it("长名字：限制最大宽度 + 省略号（truncate），并提供 Tooltip 显示完整名称", () => {
		const long = "extremely-long-channel-name-that-should-be-truncated-in-the-pill";
		const html = markup(presence({ display: [long], opened: true, mounted: true }));
		expect(html).toContain("max-w-[300px]");
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
