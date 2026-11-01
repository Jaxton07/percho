import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareMediaFork } from "../src/session/media-fork";
import { SessionMediaStore } from "../src/session/media-store";

let directory: string;
beforeEach(async () => {
	const root = resolve("../../.local/tmp/media-fork-tests");
	await mkdir(root, { recursive: true });
	directory = await mkdtemp(join(root, "run-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("可发现前准备媒体分叉", () => {
	it("复制中途ENOSPC不发布新JSONL，不改源，清理暂存和未完成目标owner", async () => {
		let copies = 0;
		const media = new SessionMediaStore(join(directory, "media"), {
			link: async () => {
				throw Object.assign(new Error("no hard links"), { code: "EXDEV" });
			},
			copy: async (from, to, flags) => {
				if (++copies === 2) throw Object.assign(new Error("full"), { code: "ENOSPC" });
				await copyFile(from, to, flags);
			},
		});
		const manager = SessionManager.create(directory, join(directory, "sessions")),
			id = manager.getSessionId();
		const assets = await Promise.all(
			["one", "two"].map((value) =>
				media.put(
					media.lease(id, () => true),
					Buffer.from(value),
					"image/png",
				),
			),
		);
		const append = (message: unknown) =>
			manager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
		append({ role: "user", timestamp: 1, content: "synthetic" });
		append({
			role: "assistant",
			timestamp: 2,
			content: [{ type: "toolCall", id: "call", name: "show_image", arguments: {} }],
		});
		append({
			role: "toolResult",
			timestamp: 3,
			toolName: "show_image",
			toolCallId: "call",
			content: [],
			details: { images: assets, paths: [] },
		});
		const leaf = append({ role: "assistant", timestamp: 4, content: [{ type: "text", text: "done" }] });
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing source");
		const before = await readFile(file, "utf8"),
			beforeEntries = JSON.stringify(manager.getEntries());
		await expect(
			prepareMediaFork(manager, file, leaf, media, join(directory, "forks")),
		).rejects.toMatchObject({ code: "ENOSPC" });
		expect(manager.getSessionId()).toBe(id);
		expect(manager.getLeafId()).toBe(leaf);
		expect(JSON.stringify(manager.getEntries())).toBe(beforeEntries);
		expect(await readFile(file, "utf8")).toBe(before);
		expect(
			(await readdir(join(directory, "sessions"))).filter((name) => name.endsWith(".jsonl")),
		).toHaveLength(1);
		expect(await readdir(join(directory, "forks"))).toHaveLength(0);
		expect(await readdir(join(directory, "media"))).toEqual([id]);
		for (const asset of assets) expect((await media.read(id, asset.id, asset.revision)).byteLength).toBe(3);
	});
	it("退出/失去发布许可不在普通历史目录留下候选JSONL", async () => {
		const manager = SessionManager.create(directory, join(directory, "sessions"));
		manager.appendMessage({ role: "user", timestamp: 1, content: "synthetic" });
		const leaf = manager.appendMessage({
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text: "answer" }],
		} as never);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing source");
		await expect(
			prepareMediaFork(
				manager,
				file,
				leaf,
				new SessionMediaStore(join(directory, "media")),
				join(directory, "forks"),
				() => false,
			),
		).rejects.toThrow("no longer writable");
		expect(
			(await readdir(join(directory, "sessions"))).filter((name) => name.endsWith(".jsonl")),
		).toHaveLength(1);
	});
});
