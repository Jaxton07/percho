import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMediaStore } from "../src/session/media-store";
import { makeShowImageTool, type ShowImagePublisherFactory } from "../src/tools/show-image";

let root: string;
beforeEach(async () => {
	const directory = resolve("../../.local/tmp/show-image-media");
	await mkdir(directory, { recursive: true });
	root = await mkdtemp(join(directory, "run-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
	"base64",
);
function context(owner = "source") {
	return {
		cwd: root,
		sessionManager: { getSessionId: () => owner, getSessionFile: () => join(root, `${owner}.jsonl`) },
	} as never;
}
function publisher(store: SessionMediaStore): ShowImagePublisherFactory {
	return (owner) => {
		const lease = store.lease(owner, () => true);
		return { assert: lease.assert, publish: (data, mime) => store.put(lease, data, mime) };
	};
}

describe("show_image原字节生产者", () => {
	it("一个工具实例每次从ctx捕获真实owner，单图/多图跨会话不共用目录", async () => {
		await writeFile(join(root, "a.png"), png);
		await writeFile(join(root, "alias.jpg"), png);
		const store = new SessionMediaStore(join(root, "media")),
			factory = vi.fn(publisher(store)),
			tool = makeShowImageTool(factory);
		const a = await tool.execute(
			"same-call",
			{ paths: ["a.png", "alias.jpg"] },
			undefined,
			undefined,
			context("a"),
		);
		const b = await tool.execute("same-call", { paths: ["a.png"] }, undefined, undefined, context("b"));
		expect(factory.mock.calls).toEqual([
			["a", join(root, "a.jsonl")],
			["b", join(root, "b.jsonl")],
		]);
		expect(a.details?.images[0]).toEqual(a.details?.images[1]);
		expect(a.details?.images[0]).toMatchObject({
			kind: "reference",
			ownerSessionId: "a",
			mimeType: "image/png",
		});
		expect(b.details?.images[0]).toMatchObject({ ownerSessionId: "b" });
		await rm(join(root, "a.png"));
		await rm(join(root, "alias.jpg"));
		const image = a.details?.images[0];
		if (!image || !("id" in image)) throw new Error("Missing reference");
		expect((await store.read("a", image.id, image.revision)).data).toBe(png.toString("base64"));
		expect(JSON.stringify([a, b])).not.toContain(png.toString("base64"));
	});
	it("stat后增长也只读到限制边界，绝不发布超限内容", async () => {
		await writeFile(join(root, "a.png"), png);
		let checks = 0;
		const publish = vi.fn();
		const tool = makeShowImageTool(() => ({
			assert: () => {
				if (++checks === 2) writeFileSync(join(root, "a.png"), Buffer.alloc(11 * 1024 * 1024));
			},
			publish,
		}));
		await expect(tool.execute("call", { paths: ["a.png"] }, undefined, undefined, context())).rejects.toThrow(
			/too large/,
		);
		expect(publish).not.toHaveBeenCalled();
	});
	it.each(["ENOSPC", "EACCES"])("发布失败%s不回退内联，也不留下可成功读取的半引用", async (code) => {
		await writeFile(join(root, "a.png"), png);
		const store = new SessionMediaStore(join(root, "media"), {
			beforePublish: async () => {
				throw Object.assign(new Error("publish failed"), { code });
			},
		});
		await expect(
			makeShowImageTool(publisher(store)).execute(
				"call",
				{ paths: ["a.png"] },
				undefined,
				undefined,
				context(),
			),
		).rejects.toThrow("publish failed");
		expect(await readdir(join(root, "media", "source"))).toEqual([]);
	});
	it("删除使正在发布的工具租约失效，迟到写者不能重建目录", async () => {
		await writeFile(join(root, "a.png"), png);
		let resume!: () => void, entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
				resume = resolve;
			}),
			started = new Promise<void>((resolve) => {
				entered = resolve;
			});
		const store = new SessionMediaStore(join(root, "media"), {
			beforePublish: async () => {
				entered();
				await waiting;
			},
		});
		const writing = makeShowImageTool(publisher(store)).execute(
			"call",
			{ paths: ["a.png"] },
			undefined,
			undefined,
			context(),
		);
		const failed = expect(writing).rejects.toThrow(/no longer writable/);
		await started;
		const deleting = store.deleteOwner("source");
		resume();
		await failed;
		await deleting;
		expect(await readdir(join(root, "media"))).toEqual([]);
	});
	it("九张上限原图保持轻量结果和同owner去重，第十张明确拒绝", async () => {
		const bytes = Buffer.alloc(10 * 1024 * 1024);
		png.copy(bytes);
		await writeFile(join(root, "limit.png"), bytes);
		const store = new SessionMediaStore(join(root, "media")),
			tool = makeShowImageTool(publisher(store));
		const result = await tool.execute(
			"call",
			{ paths: Array(9).fill("limit.png") },
			undefined,
			undefined,
			context(),
		);
		expect(result.details?.images).toHaveLength(9);
		expect(JSON.stringify(result).length).toBeLessThan(4096);
		expect(await readdir(join(root, "media", "source"))).toHaveLength(2);
		await expect(
			tool.execute("call", { paths: Array(10).fill("limit.png") }, undefined, undefined, context()),
		).rejects.toThrow("1-9");
	}, 30000);
});
