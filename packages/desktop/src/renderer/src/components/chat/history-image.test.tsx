import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("navigator", { language: "zh-CN" });
	// 组件链上的 store 在模块体里读 window.matchMedia（主题偏好）；SSR 下没有 window，必须给个壳
	vi.stubGlobal("window", {
		matchMedia: () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		}),
		addEventListener: () => {},
		removeEventListener: () => {},
	});
	// createPortal(node, document.body) 的第二个实参照样会被求值（即使已被 mock 成直返子树）
	vi.stubGlobal("document", { body: {} });
});

// 预览层 portal 到 body：SSR 不支持 portal，这里把 createPortal 换成直接返回子树（只为断言标签属性）
vi.mock("react-dom", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-dom")>()),
	createPortal: (node: unknown) => node,
}));

import type { ImageInput } from "@percho/shared";
import type { UIMessage } from "../../stores/transcript";
import { ATTACHMENT_IMAGE_MODE, modeForImageCount, SINGLE_IMAGE_BOX } from "./history-image-layout";
import { ImagePreviewOverlay } from "./ImagePreview";
import { MessageItem } from "./MessageItem";
import { UserMessage } from "./UserMessage";

const image = (seed: number): ImageInput => ({
	mimeType: "image/png",
	data: `seed-${seed}`,
});

const userMessage = (count: number): Extract<UIMessage, { kind: "user" }> => ({
	id: "u1",
	kind: "user",
	text: "看看这几张",
	timestamp: 1,
	images: Array.from({ length: count }, (_, index) => image(index)),
});

const imageMessage = (count: number): Extract<UIMessage, { kind: "image" }> => ({
	id: "i1",
	kind: "image",
	timestamp: 2,
	images: Array.from({ length: count }, (_, index) => image(index)),
	paths: [],
});

/** 取出所有 <img ...> 标签串 */
function imgTags(html: string): string[] {
	return html.match(/<img\b[^>]*>/g) ?? [];
}

/** 取出所有 <button ...> 标签串 */
function buttonTags(html: string): string[] {
	return html.match(/<button\b[^>]*>/g) ?? [];
}

function withClass(tags: string[], className: string): string[] {
	return tags.filter((tag) => tag.includes(`class="${className}`) || tag.includes(` ${className}`));
}

describe("历史图片：lazy/async 与稳定外盒", () => {
	beforeEach(() => {
		vi.stubGlobal("navigator", { language: "zh-CN" });
		// 测试环境走 classic JSX 运行时（与 McpPanel.test.tsx 同因）：JSX 产物要能拿到 React
		vi.stubGlobal("React", React);
	});

	it("用户附件：外盒固定 64 方格，img 铺满并走 lazy/async", () => {
		const html = renderToStaticMarkup(createElement(UserMessage, { message: userMessage(3) }));
		const tags = imgTags(html);
		expect(tags).toHaveLength(3);
		for (const tag of tags) {
			expect(tag).toContain('loading="lazy"');
			expect(tag).toContain('decoding="async"');
			expect(tag).toContain(ATTACHMENT_IMAGE_MODE.img);
		}
		// 外盒尺寸只在 button 上（img 不再自带尺寸），否则加载前后高度可能变
		const boxes = withClass(buttonTags(html), ATTACHMENT_IMAGE_MODE.box);
		expect(boxes).toHaveLength(3);
		expect(ATTACHMENT_IMAGE_MODE.box).toBe("h-16 w-16");
	});

	it("show_image 单图：稳定外盒 192×144 + object-contain（img 不带尺寸类）", () => {
		const html = renderToStaticMarkup(createElement(MessageItem, { message: imageMessage(1) }));
		const mode = modeForImageCount(1);
		expect(mode.box).toContain("h-36 w-48");
		expect(mode.img).toContain("object-contain");
		expect(SINGLE_IMAGE_BOX).toEqual({ width: 192, height: 144 });
		// 类名与常量必须一致（改一处忘另一处就会在这里炸）
		expect(mode.box).toContain(`h-${SINGLE_IMAGE_BOX.height / 4}`);
		expect(mode.box).toContain(`w-${SINGLE_IMAGE_BOX.width / 4}`);
		// max-w-full：窄窗下外盒不撑破容器
		expect(mode.box).toContain("max-w-full");
		expect(withClass(buttonTags(html), mode.box)).toHaveLength(1);
		const tag = imgTags(html)[0];
		expect(tag).toContain('loading="lazy"');
		expect(tag).toContain('decoding="async"');
		expect(tag).toContain(mode.img);
		// 尺寸来源唯一：img 自身不得再带固定尺寸类
		expect(tag).not.toMatch(/class="[^"]*\b[hw]-\d/);
	});

	it("show_image 多图分档：2–3 张 96 / 4–6 张 80 / 7–9 张 64，全部 lazy/async", () => {
		const expected = [
			{ count: 3, box: "h-24 w-24" },
			{ count: 6, box: "h-20 w-20" },
			{ count: 9, box: "h-16 w-16" },
		];
		for (const { count, box } of expected) {
			const html = renderToStaticMarkup(createElement(MessageItem, { message: imageMessage(count) }));
			expect(imgTags(html)).toHaveLength(count);
			for (const tag of imgTags(html)) {
				expect(tag).toContain('loading="lazy"');
				expect(tag).toContain('decoding="async"');
				expect(tag).toContain("object-cover");
			}
			expect(withClass(buttonTags(html), box)).toHaveLength(count);
		}
		expect(modeForImageCount(2).box).toBe("h-24 w-24");
		expect(modeForImageCount(4).box).toBe("h-20 w-20");
		expect(modeForImageCount(7).box).toBe("h-16 w-16");
	});

	it("用户消息入口与 show_image 入口共用同一套外盒规则（不会各自漂移）", () => {
		const userHtml = renderToStaticMarkup(createElement(UserMessage, { message: userMessage(2) }));
		const imageHtml = renderToStaticMarkup(createElement(MessageItem, { message: imageMessage(2) }));
		expect(withClass(buttonTags(userHtml), ATTACHMENT_IMAGE_MODE.box)).toHaveLength(2);
		expect(withClass(buttonTags(imageHtml), modeForImageCount(2).box)).toHaveLength(2);
	});

	it("预览：只渲染当前图，异步解码但不 lazy、不预加载相邻图", () => {
		const html = renderToStaticMarkup(
			createElement(ImagePreviewOverlay, {
				images: Array.from({ length: 9 }, (_, index) => image(index)),
				initialIndex: 3,
				onClose: () => {},
			}),
		);
		const tags = imgTags(html);
		expect(tags).toHaveLength(1);
		expect(tags[0]).toContain('decoding="async"');
		expect(tags[0]).not.toContain("loading=");
		expect(html).toContain("4 / 9");
	});
});
