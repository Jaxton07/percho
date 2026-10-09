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
import { createHistoryImageBinding, INERT_SNAPSHOT } from "./history-image/history-image-binding";
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

	it("失败态：主点仍是打开原图预览，另有独立 ghost 重试（不改变外盒尺寸）", () => {
		const opened: number[] = [];
		const retried: number[] = [];
		const html = renderToStaticMarkup(
			createElement(HistoryImageSurface, {
				snapshot: snapshot("error"),
				boxClass: "h-16 w-16",
				imgClass: ATTACHMENT_IMAGE_MODE.img,
				alt: "图片",
				onOpen: () => opened.push(1),
				onRetry: () => retried.push(1),
			}),
		);
		// 两个 button：主覆盖层（打开原图）+ 右下角小 ghost（重试）
		const buttons = html.match(/<button\b[^>]*>/g) ?? [];
		expect(buttons).toHaveLength(2);
		expect(html).toContain("重新加载");
		// 尺寸仍由外盒决定：没有内联宽高、也没有给按钮加尺寸类
		expect(html).toContain('class="h-16 w-16');
		void opened;
		void retried;
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

describe("历史图片接线（binding）：只加载加载区内的图", () => {
	function fakeEnvironment() {
		const acquired: { image: ImageInput; visible: boolean }[] = [];
		const visibility: boolean[] = [];
		const state = {
			released: 0,
			retried: 0,
			observed: 0,
			stopped: 0,
			subscribed: 0,
			unsubscribed: 0,
			snapshotStatus: "loading" as ThumbnailSnapshot["status"],
			listeners: new Set<() => void>(),
		};
		const emitHandleChange = (status: ThumbnailSnapshot["status"]) => {
			state.snapshotStatus = status;
			for (const listener of [...state.listeners]) listener();
		};
		const handle: ThumbnailHandle = {
			getSnapshot: () => ({
				status: state.snapshotStatus,
				url: state.snapshotStatus === "ready" ? "blob:thumb" : null,
				width: state.snapshotStatus === "ready" ? 384 : null,
				height: state.snapshotStatus === "ready" ? 240 : null,
			}),
			subscribe: (listener) => {
				state.subscribed += 1;
				state.listeners.add(listener);
				return () => {
					state.unsubscribed += 1;
					state.listeners.delete(listener);
				};
			},
			setVisible: (visible) => visibility.push(visible),
			retry: () => {
				state.retried += 1;
			},
			release: () => {
				state.released += 1;
				state.listeners.clear();
			},
		};
		const service = {
			acquire: (acquireImage: ImageInput, options?: { visible?: boolean }) => {
				acquired.push({ image: acquireImage, visible: options?.visible !== false });
				return handle;
			},
			reset: () => {},
			subscribeReset: () => () => {},
			stats: () => ({}) as never,
		} as unknown as ThumbnailService;
		let onVisibility: ((state: { inLoadRange: boolean; inViewport: boolean }) => void) | null = null;
		const observer: HistoryImageObserver = {
			observe: (_target, onChange) => {
				state.observed += 1;
				onVisibility = onChange;
				return () => {
					state.stopped += 1;
					onVisibility = null;
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
			emitHandleChange,
			emitVisibility: (inLoadRange: boolean, inViewport: boolean) =>
				onVisibility?.({ inLoadRange, inViewport }),
		};
	}

	it("false 初态不 acquire、不发请求；进入加载区才 acquire（可见性来自观察者）", () => {
		const fake = fakeEnvironment();
		const binding = createHistoryImageBinding({
			service: fake.service,
			image: image(1),
			element: {} as Element,
			observer: fake.observer,
		});
		expect(fake.state.observed).toBe(1);
		expect(fake.acquired).toHaveLength(0);
		expect(binding.getSnapshot().status).toBe("idle");

		fake.emitVisibility(false, false);
		expect(fake.acquired).toHaveLength(0);

		fake.emitVisibility(true, true);
		expect(fake.acquired).toHaveLength(1);
		expect(fake.acquired[0]?.visible).toBe(true);

		fake.emitVisibility(true, false);
		expect(fake.visibility).toEqual([false]);
	});

	it("加载范围内但不在可视区：acquire 的初始可见性是 false", () => {
		const fake = fakeEnvironment();
		createHistoryImageBinding({
			service: fake.service,
			image: image(2),
			element: {} as Element,
			observer: fake.observer,
		});
		fake.emitVisibility(true, false);
		expect(fake.acquired).toHaveLength(1);
		expect(fake.acquired[0]?.visible).toBe(false);
	});

	it("退出加载区立即 release：快照回稳定占位、不再转发 handle 变化、监听解除", () => {
		const fake = fakeEnvironment();
		const binding = createHistoryImageBinding({
			service: fake.service,
			image: image(3),
			element: {} as Element,
			observer: fake.observer,
		});
		fake.emitVisibility(true, true);
		fake.emitHandleChange("ready");
		expect(binding.getSnapshot().status).toBe("ready");
		const seen: string[] = [];
		binding.subscribe(() => seen.push(binding.getSnapshot().status));

		fake.emitVisibility(false, false);
		expect(fake.state.released).toBe(1);
		expect(fake.state.unsubscribed).toBeGreaterThanOrEqual(1);
		expect(binding.getSnapshot()).toMatchObject({ status: "idle", url: null });

		// 在途结果迟到：handle 已经不在绑定里，不能再影响快照
		fake.emitHandleChange("error");
		expect(binding.getSnapshot().status).toBe("idle");
	});

	it("再次进入加载区会重新 acquire（缓存命中由服务负责，不再重复解码）", () => {
		const fake = fakeEnvironment();
		createHistoryImageBinding({
			service: fake.service,
			image: image(4),
			element: {} as Element,
			observer: fake.observer,
		});
		fake.emitVisibility(true, true);
		fake.emitVisibility(false, false);
		fake.emitVisibility(true, true);
		expect(fake.acquired).toHaveLength(2);
		expect(fake.state.released).toBe(1);
	});

	it("没有 element/observer：彻底惰性（不观察也不加载）", () => {
		const fake = fakeEnvironment();
		const binding = createHistoryImageBinding({
			service: fake.service,
			image: image(5),
			element: null,
			observer: null,
		});
		expect(fake.state.observed).toBe(0);
		expect(fake.acquired).toHaveLength(0);
		expect(binding.getSnapshot()).toBe(INERT_SNAPSHOT);
		binding.retry();
		expect(fake.state.retried).toBe(0);
	});

	it("dispose 断开观察并释放；再订阅不再收到任何回调（StrictMode 式取消安全）", () => {
		const fake = fakeEnvironment();
		const binding = createHistoryImageBinding({
			service: fake.service,
			image: image(6),
			element: {} as Element,
			observer: fake.observer,
		});
		fake.emitVisibility(true, true);
		const listener = vi.fn();
		const stop = binding.subscribe(listener);
		binding.dispose();
		binding.dispose();
		expect(fake.state.stopped).toBe(1);
		expect(fake.state.released).toBe(1);
		stop();
		expect(listener).not.toHaveBeenCalled();

		// StrictMode 式重建：新 binding 从零开始（订阅计数不泄漏）
		const rebuilt = createHistoryImageBinding({
			service: fake.service,
			image: image(6),
			element: {} as Element,
			observer: fake.observer,
		});
		fake.emitVisibility(true, true);
		expect(fake.state.subscribed).toBe(2);
		expect(fake.state.unsubscribed).toBe(1);
		rebuilt.dispose();
		expect(fake.state.unsubscribed).toBe(2);
	});

	it("绑定层订阅与 handle 是否存在解耦：没有 handle 时订阅依然可用", () => {
		const fake = fakeEnvironment();
		const binding = createHistoryImageBinding({
			service: fake.service,
			image: image(7),
			element: {} as Element,
			observer: fake.observer,
		});
		const listener = vi.fn();
		const stop = binding.subscribe(listener);
		// 进入加载区（有 handle）→ 状态变化会通知
		fake.emitVisibility(true, true);
		fake.emitHandleChange("ready");
		expect(listener).toHaveBeenCalled();
		// 退出加载区（无 handle）→ 状态变化（回占位）同样通知
		const before = listener.mock.calls.length;
		fake.emitVisibility(false, false);
		expect(listener.mock.calls.length).toBeGreaterThan(before);
		stop();
	});
});
