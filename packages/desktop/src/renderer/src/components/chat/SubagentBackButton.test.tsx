import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 子代理返回入口（spec D4 / review R5）：
 * - **仅一枚 21px ghost 图标**（验收后由 14px 放大 1.5 倍）：无常驻文案、无胶囊、无原生 title（文案只在 Tooltip 与 aria-label）；
 * - 固定方形尺寸 + `self-start`：不被同容器里更宽的插件贡献拉伸；
 * - Tooltip 用 `align="start"`：气泡左对齐向右伸展，居中锚点气泡会向左溢出（撑出幻影横向滚动条）；
 * - 没有关系时**不留占位**（返回空串）。
 *
 * 注：classic JSX + zustand v5 的 SSR 快照取 `getInitialState()` ⇒ 按本仓既有做法用普通 selector 函数喂状态。
 */
const state = vi.hoisted(() => ({ activeSessionId: "sub-1" as string | null, hasRelation: false }));

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../stores/sessions", () => ({
	useSessionsStore: (selector: (s: unknown) => unknown) =>
		selector({ activeSessionId: state.activeSessionId, returnToParent: async () => true }),
}));
vi.mock("../../stores/subagent-return", () => ({
	useSubagentReturnStore: (selector: (s: unknown) => unknown) =>
		selector({
			relations: state.hasRelation ? { "sub-1": { parentSessionId: "parent", parentFile: "/p.jsonl" } } : {},
		}),
}));

import { SubagentBackButton } from "./SubagentBackButton";

const markup = () => renderToStaticMarkup(<SubagentBackButton />);
const buttonHtml = (html: string) => html.match(/<button[\s\S]*?<\/button>/)?.[0] ?? "";

beforeEach(() => {
	vi.stubGlobal("React", React); // classic JSX：给产品文件提供 React 全局（仅本文件）
	state.activeSessionId = "sub-1";
	state.hasRelation = true;
});

afterEach(() => vi.unstubAllGlobals());

describe("SubagentBackButton", () => {
	it("没有父关系：不渲染（不留占位）", () => {
		state.hasRelation = false;
		expect(markup()).toBe("");
	});

	it("没有活动会话（新会话页）：不渲染", () => {
		state.activeSessionId = null;
		expect(markup()).toBe("");
	});

	it("有父关系：只渲染一枚 21px 箭头图标，没有常驻文案、没有原生 title", () => {
		const html = markup();
		const button = buttonHtml(html);
		expect(button).not.toBe("");
		expect(html).toContain('aria-label="message.subagent.backToParent"'); // 无障碍名仍在
		expect(html).not.toContain("title="); // 原生 tooltip 不重复
		// 按钮内部只有 svg，没有文本节点
		const inner = button.replace(/^<button[^>]*>/, "").replace(/<\/button>$/, "");
		expect(inner.replace(/<svg[\s\S]*?<\/svg>/, "")).toBe("");
		expect(button).toContain('width="21"'); // 放大 1.5 倍（14 → 21）
	});

	it("文案只在 Tooltip 气泡里（悬停才现），并且气泡左对齐（不向左溢出）", () => {
		const html = markup();
		expect(html).toContain('role="tooltip"');
		expect(html).toContain(">message.subagent.backToParent<");
		// align="start" ⇒ 气泡 left-0（居中锚点的 left-1/2 会向左溢出，靠左缘的入口不能用）
		expect(html).toContain("left-0");
		expect(html).not.toContain("left-1/2");
	});

	it("固定方形尺寸 + self-start：不被同容器里更宽的贡献拉伸", () => {
		const html = markup();
		const wrapper = html.match(/^<span[^>]*>/)?.[0] ?? "";
		expect(wrapper).toContain("self-start");
		const button = buttonHtml(html);
		// 42px 方框 = 21px 图标 + 各 10.5px 内边距（放大后按同比例留白）
		expect(button).toContain("h-[42px]");
		expect(button).toContain("w-[42px]");
		expect(button).toContain("shrink-0");
	});

	it("水平偏移不在 render 内联：由 subagent-back-offset 在真实 DOM 里算（SSR 里不写 style）", () => {
		// 内联 style 会挡住 imperative 写入（React 重渲染会覆盖），所以服务端/首帧不该带 transform
		expect(markup()).not.toContain("transform");
	});
});
