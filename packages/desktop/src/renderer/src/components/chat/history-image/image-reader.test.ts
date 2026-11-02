import { type DisplayImage, environmentEntityKey, type ImageInput } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import { createImageReader } from "./image-reader";

const image = (ownerSessionId: string, id = "entry:actual:show:0") => ({
	kind: "reference" as const,
	ownerSessionId,
	id,
	revision: "source-version",
	mimeType: "image/png",
});
const raw: ImageInput = { mimeType: "image/png", data: "AQID" };
const tick = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("来源绑定的有界单图读取", () => {
	it("环境换代只拒绝对应等待者，旧回应不删同key新请求且不虚构并发释放", async () => {
		const calls: Array<{ owner: string; resolve: (value: ImageInput) => void }> = [];
		const reader = createImageReader(
			(input) =>
				new Promise((resolve) =>
					calls.push({ owner: "ownerSessionId" in input ? input.ownerSessionId : "", resolve }),
				),
		);
		const remote = { kind: "ssh" as const, connectionId: "ssh", environmentId: "epoch" },
			remoteImage = image(environmentEntityKey(remote, "same"));
		const old = reader.read(remoteImage),
			rejected = expect(old).rejects.toThrow("invalidated");
		const local = reader.read(image("local"));
		await tick();
		reader.invalidateEnvironment(remote);
		await rejected;
		const next = reader.read(remoteImage);
		await tick();
		expect(calls).toHaveLength(2);
		expect(reader.stats().active).toBe(2);
		calls[0]?.resolve({ mimeType: "image/png", data: "old" });
		await tick();
		expect(calls).toHaveLength(3);
		const joined = reader.read(remoteImage);
		await tick();
		expect(calls).toHaveLength(3);
		calls[2]?.resolve({ mimeType: "image/png", data: "new" });
		calls[1]?.resolve({ mimeType: "image/png", data: "local" });
		expect((await next).data).toBe("new");
		expect((await joined).data).toBe("new");
		expect((await local).data).toBe("local");
		await tick();
		expect(reader.stats()).toMatchObject({ active: 0, queued: 0, jobs: 0, peak: 2 });
	});
	it("删除owner只取消该源；格式坏的环境身份以Promise拒绝而不抛到界面", async () => {
		let finish!: (value: ImageInput) => void;
		const fetch = vi.fn(
				() =>
					new Promise<ImageInput>((resolve) => {
						finish = resolve;
					}),
			),
			reader = createImageReader(fetch);
		const old = reader.read(image("one")),
			rejected = expect(old).rejects.toThrow("invalidated");
		const other = reader.read(image("two"));
		await tick();
		reader.invalidateOwner("one");
		await rejected;
		finish({ mimeType: "image/png", data: "old" });
		await tick();
		expect(fetch).toHaveBeenCalledTimes(2);
		finish({ mimeType: "image/png", data: "two" });
		expect((await other).data).toBe("two");
		const invalid = environmentEntityKey(
			{ kind: "ssh", connectionId: "ssh", environmentId: "broken" },
			"source",
		).replace(/%/g, "%zz");
		await expect(reader.read(image(invalid))).rejects.toThrow();
	});
	it("同环境最多1个、全局最多2个，相同ID不同环境不串，原图不缓存", async () => {
		const waiting: Array<() => void> = [];
		const fetch = vi.fn(
			(_image: DisplayImage) => new Promise<ImageInput>((resolve) => waiting.push(() => resolve(raw))),
		);
		const reader = createImageReader(fetch);
		const local = reader.read(image("local-owner"));
		const local2 = reader.read(image("local-owner", "entry:other:show:0"));
		const remote = reader.read(
			image(
				environmentEntityKey({ kind: "ssh", connectionId: "remote", environmentId: "data" }, "local-owner"),
			),
		);
		await tick();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(reader.stats()).toMatchObject({ active: 2, queued: 1, peak: 2 });
		waiting[0]?.();
		await local;
		await tick();
		expect(fetch).toHaveBeenCalledTimes(3);
		waiting[1]?.();
		waiting[2]?.();
		await Promise.all([remote, local2]);
		await tick();
		expect(reader.stats()).toMatchObject({ active: 0, queued: 0, jobs: 0 });
		const again = reader.read(image("local-owner"));
		await tick();
		expect(fetch).toHaveBeenCalledTimes(4);
		waiting[3]?.();
		await again;
	});
	it("缩略图与预览合并同一在途请求，取消一个订阅不会取消其它订阅", async () => {
		let finish = (_value: ImageInput) => {};
		const fetch = vi.fn(
			() =>
				new Promise<ImageInput>((resolve) => {
					finish = resolve;
				}),
		);
		const reader = createImageReader(fetch);
		const controller = new AbortController();
		const thumb = reader.read(image("owner"), controller.signal).catch((error: unknown) => error);
		const preview = reader.read(image("owner"));
		await tick();
		controller.abort();
		expect(await thumb).toBeInstanceOf(Error);
		finish(raw);
		expect(await preview).toBe(raw);
		await tick();
		expect(fetch).toHaveBeenCalledOnce();
		expect(reader.stats().jobs).toBe(0);
	});
	it("已离开的排队任务不读取原图，在途取消仍占真实并发到RPC结束", async () => {
		let finish = (_value: ImageInput) => {};
		const fetch = vi.fn(
			() =>
				new Promise<ImageInput>((resolve) => {
					finish = resolve;
				}),
		);
		const reader = createImageReader(fetch);
		const first = new AbortController();
		const queued = new AbortController();
		const a = reader.read(image("owner"), first.signal).catch(() => null);
		const b = reader.read(image("owner", "entry:next:show:0"), queued.signal).catch(() => null);
		await tick();
		first.abort();
		queued.abort();
		await Promise.all([a, b]);
		await tick();
		expect(fetch).toHaveBeenCalledOnce();
		expect(reader.stats()).toMatchObject({ active: 1, queued: 0 });
		finish(raw);
		await tick();
		expect(reader.stats()).toMatchObject({ active: 0, jobs: 0 });
	});
	it("失败后重试不继承错误或原图；内联数据不进入来源调度", async () => {
		const fetch = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(raw);
		const reader = createImageReader(fetch);
		await expect(reader.read(image("owner"))).rejects.toThrow("unavailable");
		expect(await reader.read(image("owner"))).toEqual(raw);
		expect(await reader.read(raw)).toBe(raw);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
