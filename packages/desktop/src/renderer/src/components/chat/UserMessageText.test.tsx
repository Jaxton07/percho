import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
	states: [false, false, false],
	cursor: 0,
	height: 153,
	lineHeight: 25.5,
	measure: () => {},
	cleanup: undefined as (() => void) | undefined,
	disconnect: vi.fn(),
}));

vi.mock("../../i18n", () => ({
	useT: () => (key: string) => (key === "message.showMore" ? "显示更多" : "收起"),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useId: () => "message-text",
	useRef: () => ({ current: { getBoundingClientRect: () => ({ height: harness.height }) } }),
	useState: () => {
		const index = harness.cursor++;
		return [
			harness.states[index],
			(value: boolean) => {
				harness.states[index] = value;
			},
		];
	},
	useLayoutEffect: (effect: () => () => void) => {
		harness.cleanup = effect();
	},
}));

import * as React from "react";
import { UserMessageText } from "./UserMessageText";

function render(text = "完整原文") {
	harness.cursor = 0;
	return renderToStaticMarkup(createElement(UserMessageText, null, text));
}

beforeEach(() => {
	harness.states = [false, false, false];
	harness.height = 153;
	harness.lineHeight = 25.5;
	harness.disconnect.mockClear();
	vi.stubGlobal("React", React);
	vi.stubGlobal("getComputedStyle", () => ({ lineHeight: String(harness.lineHeight) }));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				harness.measure = callback;
			}
			observe() {}
			disconnect = harness.disconnect;
		},
	);
});

describe("用户正文折叠（受控布局测量）", () => {
	it("恰好六行和短消息不显示开关", () => {
		expect(render()).not.toContain("<button");
		expect(harness.states[0]).toBe(false);
	});

	it("超出六行默认收起，保留完整原文且按钮在裁切层之外", () => {
		harness.height = 178.5;
		render(); // layout effect 触发后的重渲染
		const html = render("不截断的完整原文");
		expect(html).toContain('data-collapsed="true"');
		expect(html).toContain("不截断的完整原文</div></div><button");
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('aria-controls="message-text"');
		expect(html).toContain("显示更多");
	});

	it("展开时去掉渐隐裁切并显示收起，再收起恢复", () => {
		harness.height = 300;
		render();
		harness.states[1] = true;
		const html = render();
		expect(html).not.toContain("data-collapsed");
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("收起");
		harness.states[1] = false;
		expect(render()).toContain('data-collapsed="true"');
	});

	it("窗口变窄、字号改变时按实际行高重新测量", () => {
		render();
		harness.height = 300;
		harness.measure();
		expect(harness.states[0]).toBe(true);
		harness.lineHeight = 50;
		harness.measure();
		expect(harness.states[0]).toBe(false);
	});

	it("卸载释放尺寸观察器", () => {
		render();
		harness.cleanup?.();
		expect(harness.disconnect).toHaveBeenCalledOnce();
	});
});
