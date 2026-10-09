import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("navigator", { language: "zh-CN" });
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
	vi.stubGlobal("document", { body: {} });
});

// 预览层 portal 到 body：SSR 不支持 portal，这里把 createPortal 换成直接返回子树（只为断言标签属性）
vi.mock("react-dom", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-dom")>()),
	createPortal: (node: unknown) => node,
}));

import type { ImageInput } from "@percho/shared";
import * as React from "react";
import type { UIMessage } from "../../stores/transcript";
import { HistoryImage, HistoryImageSurface } from "./history-image/HistoryImage";
import { createHistoryImageBinding } from "./history-image/history-image-binding";
import type { HistoryImageObserver } from "./history-image/history-image-observer";
import type {
	ThumbnailHandle,
	ThumbnailService,
	ThumbnailSnapshot,
} from "./history-image/history-image-service";
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

function withClass(html: string, className: string): string[] {
	return (html.match(/class="[^"]*"/g) ?? []).filter((value) => value.includes(className));
}

const snapshot = (status: ThumbnailSnapshot["status"], url: string | null = null): ThumbnailSnapshot => ({
	status,
	url,
	width: status === "ready" ? 384 : null,
	height: status === "ready" ? 240 : null,
});

function renderUser(count: number): string {
	return renderToStaticMarkup(createElement(UserMessage, { message: userMessage(count) }));
}

function renderImageMessage(count: number): string {
	return renderToStaticMarkup(createElement(MessageItem, { message: imageMessage(count) }));
}

describe("历史图片：外盒几何与三态占位（阶段 3 接线后）", () => {
	beforeEach(() => {
		vi.stubGlobal("navigator", { language: "zh-CN" });
		// 测试环境走 classic JSX 运行时（与 McpPanel.test.tsx 同因）：JSX 产物要能拿到 React
		vi.stubGlobal("React", React);
	});

	it("用户附件：外盒固定 64 方格，未加载时只有占位、没有 <img>（不 fallback 原图）", () => {
		const html = renderUser(3);
		expect(imgTags(html)).toHaveLength(0);
		expect(withClass(html, ATTACHMENT_IMAGE_MODE.box)).toHaveLength(3);
		expect(ATTACHMENT_IMAGE_MODE.box).toBe("h-16 w-16");
		expect(html).toContain('data-history-image="idle"');
		// 占位点击仍是打开原图预览（overlay button 的 aria-label 带「查看图片」）
		expect(html).toContain("查看图片");
		expect(html).toContain("图片待加载");
	});

	it("show_image 单图：稳定外盒 192×144 + object-contain（占位态同样尺寸）", () => {
		const mode = modeForImageCount(1);
		expect(mode.box).toContain("h-36 w-48");
		expect(mode.img).toContain("object-contain");
		expect(SINGLE_IMAGE_BOX).toEqual({ width: 192, height: 144 });
		expect(mode.box).toContain(`h-${SINGLE_IMAGE_BOX.height / 4}`);
		expect(mode.box).toContain(`w-${SINGLE_IMAGE_BOX.width / 4}`);
		expect(mode.box).toContain("max-w-full");
		const html = renderImageMessage(1);
		expect(imgTags(html)).toHaveLength(0);
		expect(withClass(html, mode.box)).toHaveLength(1);
	});

	it("show_image 多图分档：2–3 张 96 / 4–6 张 80 / 7–9 张 64，占位不改变外盒", () => {
		const expected = [
			{ count: 3, box: "h-24 w-24" },
			{ count: 6, box: "h-20 w-20" },
			{ count: 9, box: "h-16 w-16" },
		];
		for (const { count, box } of expected) {
			const html = renderImageMessage(count);
			expect(withClass(html, box)).toHaveLength(count);
			expect(imgTags(html)).toHaveLength(0);
		}
		expect(modeForImageCount(2).box).toBe("h-24 w-24");
		expect(modeForImageCount(4).box).toBe("h-20 w-20");
		expect(modeForImageCount(7).box).toBe("h-16 w-16");
	});

	it("就绪态：img 只指向缩略图 blob，带 lazy/async（spec P2）", () => {
		const html = renderToStaticMarkup(
			createElement(HistoryImageSurface, {
				snapshot: snapshot("ready", "blob:thumb-1"),
				boxClass: modeForImageCount(1).box,
				imgClass: modeForImageCount(1).img,
				alt: "图片",
				onOpen: () => {},
				onRetry: () => {},
			}),
		);
		const tags = imgTags(html);
		expect(tags).toHaveLength(1);
		expect(tags[0]).toContain('src="blob:thumb-1"');
		expect(tags[0]).toContain('decoding="async"');
		expect(tags[0]).toContain('loading="lazy"');
		expect(tags[0]).not.toContain("data:");
		expect(html).toContain('data-history-image="ready"');
	});

	it("加载中/失败态：都没有 <img>，失败态给重试文案（中英字典）", () => {
		for (const status of ["idle", "loading"] as const) {
			const html = renderToStaticMarkup(
				createElement(HistoryImageSurface, {
					snapshot: snapshot(status),
					boxClass: "h-16 w-16",
					imgClass: ATTACHMENT_IMAGE_MODE.img,
					alt: "图片",
					onOpen: () => {},
					onRetry: () => {},
				}),
			);
			expect(imgTags(html)).toHaveLength(0);
			expect(html).toContain(`data-history-image="${status}"`);
			expect(html).toContain("图片待加载");
		}
		const failed = renderToStaticMarkup(
			createElement(HistoryImageSurface, {
				snapshot: snapshot("error"),
				boxClass: "h-16 w-16",
				imgClass: ATTACHMENT_IMAGE_MODE.img,
				alt: "图片",
				onOpen: () => {},
				onRetry: () => {},
			}),
		);
		expect(imgTags(failed)).toHaveLength(0);
		expect(failed).toContain('data-history-image="error"');
		expect(failed).toContain("图片加载失败");
		expect(failed).toContain("重新加载");
	});

	it("组件在没接线（无 root）时只渲染占位，绝不去加载", () => {
		const html = renderToStaticMarkup(
			createElement(HistoryImage, {
				image: image(1),
				boxClass: ATTACHMENT_IMAGE_MODE.box,
				imgClass: ATTACHMENT_IMAGE_MODE.img,
				alt: "图片",
				onOpen: () => {},
			}),
		);
		expect(imgTags(html)).toHaveLength(0);
		expect(html).toContain('data-history-image="idle"');
	});

	it("用户消息入口与 show_image 入口共用同一套外盒规则（不会各自漂移）", () => {
		expect(withClass(renderUser(2), ATTACHMENT_IMAGE_MODE.box)).toHaveLength(2);
		expect(withClass(renderImageMessage(2), modeForImageCount(2).box)).toHaveLength(2);
	});

	it("预览：只渲染当前图（原图），异步解码但不 lazy、不预加载相邻图", () => {
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

describe("历史图片接线（binding）：不偷用 visible=true、可见性来自观察者、销毁即释放", () => {
	function fakeEnvironment() {
		const acquired: { image: ImageInput; visible: boolean }[] = [];
		const visibility: boolean[] = [];
		const state = { released: 0, retried: 0, observed: 0, stopped: 0, listeners: new Set<() => void>() };
		const handle: ThumbnailHandle = {
			getSnapshot: () => snapshot("loading"),
			subscribe: (listener) => {
				state.listeners.add(listener);
				return () => state.listeners.delete(listener);
			},
			setVisible: (visible) => visibility.push(visible),
			retry: () => {
				state.retried += 1;
			},
			release: () => {
				state.released += 1;
			},
		};
		const service = {
			acquire: (acquireImage: ImageInput, options?: { visible?: boolean }) => {
				acquired.push({ image: acquireImage, visible: options?.visible !== false });
				return handle;
			},
			reset: () => {},
			stats: () => ({}) as never,
		} as unknown as ThumbnailService;
		let onVisibility: ((state: { inLoadRange: boolean; inViewport: boolean }) => void) | null = null;
		const observer: HistoryImageObserver = {
			observe: (_target, onChange) => {
				state.observed += 1;
				onVisibility = onChange;
				return () => {
					state.stopped += 1;
				};
			},
			disconnect: () => {},
			stats: () => ({
				targets: 1,
				inRange: 1,
				observers: 1,
				viewportSubscriptions: 1,
				rootResizeSubscriptions: 1,
			}),
		};
		return {
			acquired,
			visibility,
			state,
			service,
			observer,
			emitVisibility: (visible: boolean) => onVisibility?.({ inLoadRange: true, inViewport: visible }),
		};
	}

	it("初始可见性必须是 false：真实可见只来自观察者", () => {
		const fake = fakeEnvironment();
		createHistoryImageBinding({
			service: fake.service,
			image: image(1),
			element: {} as Element,
			observer: fake.observer,
		});
		expect(fake.acquired).toHaveLength(1);
		expect(fake.acquired[0]?.visible).toBe(false);
		expect(fake.state.observed).toBe(1);
		fake.emitVisibility(true);
		expect(fake.visibility).toEqual([true]);
		fake.emitVisibility(false);
		expect(fake.visibility).toEqual([true, false]);
	});

	it("没有观察目标/观察者时：不建立可见性订阅、也不改变可见性", () => {
		const fake = fakeEnvironment();
		const binding = createHistoryImageBinding({
			service: fake.service,
			image: image(1),
			element: null,
			observer: null,
		});
		expect(fake.state.observed).toBe(0);
		expect(fake.visibility).toEqual([]);
		expect(binding.getSnapshot().status).toBe("loading");
	});

	it("dispose 同时断开观察与释放句柄，且幂等", () => {
		const fake = fakeEnvironment();
		const binding = createHistoryImageBinding({
			service: fake.service,
			image: image(1),
			element: {} as Element,
			observer: fake.observer,
		});
		binding.dispose();
		binding.dispose();
		expect(fake.state.stopped).toBe(1);
		expect(fake.state.released).toBe(1);
		// 释放之后读快照是惰性态、订阅无效
		expect(binding.getSnapshot().status).toBe("idle");
		const listener = vi.fn();
		binding.subscribe(listener)();
		expect(listener).not.toHaveBeenCalled();
	});
});
