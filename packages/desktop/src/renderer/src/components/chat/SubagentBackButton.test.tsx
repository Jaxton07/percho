import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 子代理返回入口（spec D4 / review R5）：
 * - **仅一枚 21px ghost 图标**（验收后由 14px 放大 1.5 倍）：无常驻文案、无胶囊、无原生 title、**无 Tooltip 气泡**
 *   （产品侧要求不出现文字提示）—— 语义只靠 `aria-label`；
 * - 固定方形尺寸 + `self-start`：不被同容器里更宽的插件贡献拉伸；
 * - 挂载点是 `RegionHost(chat.corner.top-left)` 的 `leading` 插槽（与左上区域贡献共容器，互不重叠）；
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

	it("不出现任何文字提示：没有 Tooltip 气泡、没有可见文案，语义只在 aria-label", () => {
		const html = markup();
		expect(html).not.toContain('role="tooltip"');
		expect(html).not.toContain("group/tooltip");
		// 文案只作为无障碍名出现（不会画在界面上）
		const visibleText = html.replace(/<[^>]*>/g, "").trim();
		expect(visibleText).toBe(""); // 去掉标签后没有任何文本节点
		expect(html).toContain('aria-label="message.subagent.backToParent"');
	});

	it("固定方形尺寸 + self-start：不被同容器里更宽的贡献拉伸", () => {
		const html = markup();
		// 按钮本身就是 flex item（去掉 Tooltip 包裹层后要自己扛 self-start）
		expect(html).toContain("self-start");
		const button = buttonHtml(html);
		// 42px 方框 = 21px 图标 + 各 10.5px 内边距（放大后按同比例留白）
		expect(button).toContain("h-[42px]");
		expect(button).toContain("w-[42px]");
		expect(button).toContain("shrink-0");
		expect(button).toContain("pointer-events-auto"); // 角容器整体 pointer-events-none
	});

	it("水平偏移不在 render 内联：由 subagent-back-offset 在真实 DOM 里算（SSR 里不写 style）", () => {
		// 内联 style 会挡住 imperative 写入（React 重渲染会覆盖），所以服务端/首帧不该带 transform
		expect(markup()).not.toContain("transform");
	});
});
