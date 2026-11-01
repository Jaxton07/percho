import {
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISPLAY_IMAGE_BYTES, SessionMediaStore } from "../src/session/media-store";
import { privateDirectory } from "../src/storage/private-directory";

let directory: string;
beforeEach(async () => {
	const root = resolve("../../.local/tmp/media-store-tests");
	await mkdir(root, { recursive: true });
	directory = await mkdtemp(join(root, "run-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
const bytes = Buffer.from("original image bytes - not a transformed thumbnail");
function make(options: ConstructorParameters<typeof SessionMediaStore>[1] = {}) {
	return new SessionMediaStore(join(directory, "media"), options);
}

describe("原字节私有媒体与发布生命期", () => {
	it("完整数据树备份/搬迁后仍解析原字节，不依赖原根目录路径", async () => {
		const agent = join(directory, "agent"),
			backup = join(directory, "backup");
		await mkdir(agent);
		const store = new SessionMediaStore(join(agent, "session-media"));
		const reference = await store.put(
			store.lease("session", () => true),
			bytes,
			"image/png",
		);
		await writeFile(join(agent, "fixture.jsonl"), JSON.stringify({ owner: "session", image: reference }), {
			mode: 0o600,
		});
		await mkdir(backup);
		await privateDirectory(backup, true);
		await cp(agent, backup, { recursive: true });
		await rm(agent, { recursive: true });
		const restored = new SessionMediaStore(join(backup, "session-media"));
		expect(JSON.parse(await readFile(join(backup, "fixture.jsonl"), "utf8")).image).toEqual(reference);
		expect((await restored.read("session", reference.id, reference.revision)).data).toBe(
			bytes.toString("base64"),
		);
	});
	it("原字节sha、同owner去重、不同owner隔离、关闭重开不删图", async () => {
		const store = make();
		const current = {};
		store.openOwner("first", current);
		const lease = store.lease("first", () => true);
		const first = await store.put(lease, bytes, "image/png");
		expect(await store.put(lease, bytes, "image/png")).toEqual(first);
		expect(await readdir(join(directory, "media/first"))).toHaveLength(2);
		expect((await store.read("first", first.id, first.revision)).data).toBe(bytes.toString("base64"));
		store.closeOwner("first", current);
		store.openOwner("first", {});
		await expect(store.put(lease, bytes, "image/png")).rejects.toThrow("no longer writable");
		expect((await store.read("first", first.id, first.revision)).byteLength).toBe(bytes.length);
		await expect(store.read("second", first.id, first.revision)).rejects.toThrow();
		await expect(store.read("first", first.id, "old")).rejects.toThrow("identity");
		await expect(
			store.put(
				store.lease("first", () => true),
				Buffer.alloc(DISPLAY_IMAGE_BYTES + 1),
				"image/png",
			),
		).rejects.toThrow("oversized");
	});
	it("发布暂停时删除：旧发布被撤销，删除返回后迟到租约不重建目录", async () => {
		let resume = () => {};
		let started = () => {};
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const store = make({
			beforePublish: async () => {
				started();
				await blocked;
			},
		});
		const lease = store.lease("owner", () => true);
		const publishing = store.put(lease, bytes, "image/png").catch((error: unknown) => error);
		await ready;
		const deleting = store.deleteOwner("owner");
		resume();
		expect(await publishing).toBeInstanceOf(Error);
		await deleting;
		await expect(lstat(join(directory, "media/owner"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(store.put(lease, bytes, "image/png")).rejects.toThrow("no longer writable");
		await expect(lstat(join(directory, "media/owner"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("读取文件尚未结束就删除：租约失效在任何mkdir之前被拒绝；旧close不关新实例", async () => {
		const store = make();
		const old = {},
			fresh = {};
		store.openOwner("owner", old);
		const lease = store.lease("owner", () => true);
		await store.deleteOwner("owner");
		await expect(store.put(lease, bytes, "image/png")).rejects.toThrow();
		await expect(lstat(join(directory, "media"))).rejects.toMatchObject({ code: "ENOENT" });
		store.openOwner("owner", fresh);
		store.closeOwner("owner", old);
		await expect(
			store.put(
				store.lease("owner", () => true),
				bytes,
				"image/png",
			),
		).resolves.toMatchObject({ kind: "reference" });
	});
	it("分叉优先硬链接、不可用则复制；删除源仍可读取目标，真字节或校验损坏明确报错", async () => {
		const store = make({
			link: async () => {
				throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
			},
		});
		const reference = await store.put(
			store.lease("source", () => true),
			bytes,
			"image/png",
		);
		await store.copyAsset(
			"source",
			store.lease("fork", () => true),
			reference.id,
			reference.revision,
		);
		await store.deleteOwner("source");
		expect((await store.read("fork", reference.id, reference.revision)).data).toBe(bytes.toString("base64"));
		const file = join(directory, "media/fork", `${reference.revision}.bin`);
		await writeFile(file, Buffer.alloc(bytes.length, 0), { mode: 0o600 });
		await expect(store.read("fork", reference.id, reference.revision)).rejects.toThrow("checksum");
		await writeFile(file, Buffer.concat([bytes, bytes]));
		await expect(store.read("fork", reference.id, reference.revision)).rejects.toThrow(/size/);
	});
	it("原字节已落盘而metadata发布前中断，重复发布可补全且不改原图", async () => {
		const store = make(),
			lease = store.lease("partial", () => true);
		const reference = await store.put(lease, bytes, "image/png");
		await rm(join(directory, "media/partial", `${reference.revision}.json`));
		await expect(store.read("partial", reference.id, reference.revision)).rejects.toThrow();
		expect(await store.put(lease, bytes, "image/png")).toEqual(reference);
		expect((await store.read("partial", reference.id, reference.revision)).data).toBe(
			bytes.toString("base64"),
		);
	});
	it("同时不同owner发布也能创建唯一私有根；持久文件原字节未编码或缩小", async () => {
		const store = make();
		const refs = await Promise.all(
			["a", "b"].map((owner) =>
				store.put(
					store.lease(owner, () => true),
					bytes,
					"image/png",
				),
			),
		);
		for (const reference of refs) {
			const file = join(directory, "media", reference.ownerSessionId, `${reference.revision}.bin`);
			expect(await readFile(file)).toEqual(bytes);
			if (process.platform !== "win32") expect((await lstat(file)).mode & 0o077).toBe(0);
		}
	});
	it.skipIf(process.platform === "win32")(
		"拒绝owner目录、媒体文件及元数据的越界链接，不读取目标",
		async () => {
			const store = make();
			const reference = await store.put(
				store.lease("source", () => true),
				bytes,
				"image/png",
			);
			const outside = join(directory, "outside");
			await mkdir(outside);
			await symlink(outside, join(directory, "media/evil"), "dir");
			await expect(store.read("evil", reference.id, reference.revision)).rejects.toThrow("Linked");
			await expect(
				store.put(
					store.lease("evil", () => true),
					bytes,
					"image/png",
				),
			).rejects.toThrow("Linked");
			expect(await readdir(outside)).toHaveLength(0);
			for (const extension of ["bin", "json"]) {
				const file = join(directory, "media/source", `${reference.revision}.${extension}`);
				const original = await readFile(file);
				await rm(file);
				await symlink(join(outside, "not-readable"), file);
				await expect(store.read("source", reference.id, reference.revision)).rejects.toThrow("Linked");
				await rm(file);
				await writeFile(file, original, { mode: 0o600 });
			}
			await chmod(join(directory, "media/source"), 0o755);
			await expect(store.read("source", reference.id, reference.revision)).rejects.toThrow("not private");
		},
	);
	it("拒绝非法owner、asset路径及MIME，已保存原图不因失败被覆盖", async () => {
		const store = make();
		expect(() => store.lease("../escape", () => true)).toThrow("owner");
		const lease = store.lease("source", () => true);
		const reference = await store.put(lease, bytes, "image/png");
		await expect(store.read("source", "asset:../../elsewhere", "../../elsewhere")).rejects.toThrow(
			"identity",
		);
		await expect(store.put(lease, bytes, "text/html")).rejects.toThrow("Unsupported");
		await expect(store.put(lease, bytes, "image/jpeg")).rejects.toThrow("MIME");
		expect((await store.read("source", reference.id, reference.revision)).data).toBe(
			bytes.toString("base64"),
		);
	});
});
