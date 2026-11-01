import { describe, expect, it, vi } from "vitest";
import { createThumbnailService } from "./history-image-service";
import type { ThumbnailRequest } from "./thumbnail-protocol";

const reference = {
	kind: "reference" as const,
	ownerSessionId: "source",
	id: "entry:real:show:0",
	revision: "v1",
	mimeType: "image/png",
};
const inline = { data: "original", mimeType: "image/png" };

describe("引用图片兼容读取", () => {
	it("未绑定来源明确失败，不创建worker或原图回退", () => {
		const createWorker = vi.fn();
		const service = createThumbnailService({ createWorker });
		const handle = service.acquire(reference);
		expect(handle.getSnapshot().status).toBe("error");
		expect(createWorker).not.toHaveBeenCalled();
		handle.release();
		service.reset();
	});
	it("只在调度时解析引用，worker仍只收到模型无关的真实图片", async () => {
		const posted: ThumbnailRequest[] = [];
		const resolveImage = vi.fn(async () => inline);
		const service = createThumbnailService({
			resolveImage,
			createWorker: () =>
				({
					postMessage: (value: ThumbnailRequest) => posted.push(value),
					addEventListener() {},
					terminate() {},
				}) as unknown as Worker,
		});
		const handle = service.acquire(reference);
		await Promise.resolve();
		expect(resolveImage).toHaveBeenCalledExactlyOnceWith(reference, expect.any(AbortSignal));
		expect(posted[0]?.image).toBe(inline);
		handle.release();
		service.reset();
	});
	it("离开加载区后迟到解析不再启动解码", async () => {
		let finish = (_image: typeof inline) => {};
		const createWorker = vi.fn();
		const service = createThumbnailService({
			createWorker,
			resolveImage: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const handle = service.acquire(reference);
		handle.release();
		finish(inline);
		await Promise.resolve();
		expect(createWorker).not.toHaveBeenCalled();
		expect(service.stats().inFlight).toBe(false);
		service.reset();
	});
	it("切换后迟到解析不创建worker也不恢复旧句柄", async () => {
		let finish = (_image: typeof inline) => {};
		const createWorker = vi.fn();
		const service = createThumbnailService({
			createWorker,
			resolveImage: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const handle = service.acquire(reference);
		service.reset();
		finish(inline);
		await Promise.resolve();
		expect(createWorker).not.toHaveBeenCalled();
		expect(handle.getSnapshot().status).toBe("idle");
		expect(service.stats().keys).toBe(0);
	});
});
