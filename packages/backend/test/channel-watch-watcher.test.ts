import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelWatcher, parseWatchFilename } from "../src/tools/channel-watch/watcher";

let testRoot: string;

beforeAll(async () => {
	testRoot = await mkdtemp(join(tmpdir(), "cw-watcher-"));
});

afterAll(async () => {
	await rm(testRoot, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("parseWatchFilename", () => {
	it("解析 topic + relPath；过滤噪音", () => {
		expect(parseWatchFilename("t1/IMPL-NOTES.md")).toEqual({
			topic: "t1",
			relPath: "t1/IMPL-NOTES.md",
		});
		expect(parseWatchFilename("t1/sub/dir/f.md")?.relPath).toBe("t1/sub/dir/f.md");
		expect(parseWatchFilename(null)).toBeNull();
		expect(parseWatchFilename("")).toBeNull();
		expect(parseWatchFilename(".DS_Store")).toBeNull(); // 隐藏 topic
		expect(parseWatchFilename("t1/.DS_Store")).toBeNull(); // 隐藏文件
		expect(parseWatchFilename("t1/.#tmp")).toBeNull();
	});
});

describe("ChannelWatcher（fs.watch 模式）", () => {
	it("子树写入 → 防抖合并 → 单事件；.DS_Store 类噪音不触发", async () => {
		const root = join(testRoot, "w1");
		await mkdir(root, { recursive: true });
		const events: Array<{ topic: string; relPath: string }> = [];
		const w = new ChannelWatcher({
			channelRoot: root,
			onEvent: (e) => events.push(e),
			debounceMs: 150,
		});
		const mode = await w.start();
		expect(mode).toBe("watch");
		try {
			await mkdir(join(root, "t1"), { recursive: true });
			// 同文件连写 3 次（防抖窗口内合并）
			await writeFile(join(root, "t1/IMPL-NOTES.md"), "v1\n", { flag: "w" });
			await sleep(50);
			await writeFile(join(root, "t1/IMPL-NOTES.md"), "v2\n", { flag: "w" });
			await sleep(50);
			await writeFile(join(root, "t1/IMPL-NOTES.md"), "v3\n", { flag: "w" });
			// 噪音文件
			await writeFile(join(root, "t1/.DS_Store"), "junk", { flag: "w" });
			await sleep(500);
			expect(events.filter((e) => e.relPath === "t1/IMPL-NOTES.md")).toHaveLength(1);
			expect(events.some((e) => e.relPath.includes(".DS_Store"))).toBe(false);
		} finally {
			w.stop();
		}
	});

	it("两文件互不干扰防抖；stop 后不再触发", async () => {
		const root = join(testRoot, "w2");
		await mkdir(root, { recursive: true });
		const events: string[] = [];
		const w = new ChannelWatcher({
			channelRoot: root,
			onEvent: (e) => events.push(e.relPath),
			debounceMs: 150,
		});
		await w.start();
		await mkdir(join(root, "t2"), { recursive: true });
		await writeFile(join(root, "t2/A.md"), "a", { flag: "w" });
		await sleep(300); // A 防抖窗口过
		await writeFile(join(root, "t2/B.md"), "b", { flag: "w" });
		await sleep(400);
		expect(events.filter((x) => x === "t2/A.md")).toHaveLength(1);
		expect(events.filter((x) => x === "t2/B.md")).toHaveLength(1);
		w.stop();
		await writeFile(join(root, "t2/C.md"), "c", { flag: "w" });
		await sleep(400);
		expect(events.some((x) => x === "t2/C.md")).toBe(false);
	});
});

describe("ChannelWatcher（降级轮询模式）", () => {
	it("root 缺失时降级轮询仍能发现后续变更", async () => {
		const root = join(testRoot, "w3"); // 不存在
		const events: string[] = [];
		const w = new ChannelWatcher({
			channelRoot: root,
			onEvent: (e) => events.push(e.relPath),
			debounceMs: 10,
			pollIntervalMs: 120,
		});
		// 手动构造降级：start 里 fs.watch 对不存在 root 会 throw（macOS 上 recursive watch
		// 不存在目录报错），落到 poll 分支
		const mode = await w.start();
		expect(mode === "poll" || mode === "watch").toBe(true);
		if (mode === "watch") {
			// 某些平台对缺失目录不 throw：关闭后跳过（该平台不覆盖 poll 路径）
			w.stop();
			return;
		}
		try {
			await mkdir(join(root, "t3"), { recursive: true });
			await writeFile(join(root, "t3/F.md"), "v1", { flag: "w" });
			await sleep(600);
			expect(events).toContain("t3/F.md");
			// 内容变化（mtime/size）再触发
			await writeFile(join(root, "t3/F.md"), "v2-longer", { flag: "w" });
			await sleep(600);
			expect(events.filter((x) => x === "t3/F.md").length).toBeGreaterThanOrEqual(2);
		} finally {
			w.stop();
		}
	});
});
